// ============================================================================
// Evolution Store
//
// File-based persistence for skill evolution entries.
// Manages evolutions.json alongside SKILL.md files.
// Supports solidification (writing pending entries into SKILL.md).
// ============================================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  createEmptyEvolutionFile,
  type EvolutionEntry,
  type EvolutionFile,
} from "./evolution-schema.js";

export function buildAtomicTempPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${randomUUID()}`;
}

// ============================================================================
// Store
// ============================================================================

export class EvolutionStore {
  private readonly skillsBaseDir: string;

  constructor(skillsBaseDir: string) {
    this.skillsBaseDir = resolve(skillsBaseDir);
  }

  // --------------------------------------------------------------------------
  // Evolution file operations
  // --------------------------------------------------------------------------

  /**
   * Load the evolutions.json for a skill. Returns empty file if not found.
   */
  loadEvolutionFile(skillName: string): EvolutionFile {
    const filePath = this.evolutionFilePath(skillName);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as EvolutionFile;
    } catch (error) {
      if (this.isMissingFileError(error)) {
        return createEmptyEvolutionFile(skillName);
      }
      throw error;
    }
  }

  /**
   * Get existing description-layer entries with stable ids for LLM merge targets.
   */
  getExistingDescriptionEntries(skillName: string): Array<{ id: string; content: string }> {
    const file = this.loadEvolutionFile(skillName);
    return file.entries
      .filter((e) => e.change.target === "description" && e.change.action !== "skip")
      .map((e) => ({ id: e.id, content: e.change.content }));
  }

  /**
   * Get existing body-layer entries with stable ids for LLM merge targets.
   */
  getExistingBodyEntries(skillName: string): Array<{ id: string; content: string }> {
    const file = this.loadEvolutionFile(skillName);
    return file.entries
      .filter((e) => e.change.target === "body" && e.change.action !== "skip")
      .map((e) => ({ id: e.id, content: e.change.content }));
  }

  /**
   * Get existing entry descriptions for dedup context in LLM prompts.
   */
  getExistingDescriptions(skillName: string): string[] {
    return this.getExistingDescriptionEntries(skillName).map((entry) => entry.content);
  }

  /**
   * Get existing body entries for dedup context.
   */
  getExistingBodyEntryContents(skillName: string): string[] {
    return this.getExistingBodyEntries(skillName).map((entry) => entry.content);
  }

  private isMissingFileError(error: unknown): boolean {
    return (
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }

  /**
   * Append or merge an evolution entry for a skill.
   * Handles merge_target for dedup replacements.
   */
  appendEntry(skillName: string, entry: EvolutionEntry): void {
    const file = this.loadEvolutionFile(skillName);

    // Handle merge target: replace existing entry
    if (entry.change.mergeTarget) {
      const idx = this.resolveMergeIndex(file.entries, entry.change.mergeTarget);
      if (idx >= 0) {
        file.entries[idx] = entry;
      } else {
        file.entries.push(entry);
      }
    } else {
      file.entries.push(entry);
    }

    file.updatedAt = new Date().toISOString();
    this.saveEvolutionFile(skillName, file);
  }

  /**
   * Get all pending (unapplied) entries for a skill.
   */
  getPendingEntries(skillName: string): EvolutionEntry[] {
    const file = this.loadEvolutionFile(skillName);
    return file.entries.filter((e) => !e.applied && e.change.action !== "skip");
  }

  /**
   * Load the current SKILL.md contents for a skill when present.
   */
  loadSkillMarkdown(skillName: string): string | undefined {
    try {
      return fs.readFileSync(this.skillMdPath(skillName), "utf-8");
    } catch {
      return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Solidification: write pending body entries into SKILL.md
  // --------------------------------------------------------------------------

  /**
   * Write all pending body entries into the skill's SKILL.md file.
   * Marks entries as applied after successful write.
   * Returns the number of entries solidified.
   */
  solidify(skillName: string): number {
    const file = this.loadEvolutionFile(skillName);
    const pending = file.entries.filter(
      (e) => !e.applied && e.change.target === "body" && e.change.action !== "skip",
    );

    if (pending.length === 0) {
      return 0;
    }

    const skillMdPath = this.skillMdPath(skillName);
    let skillContent: string;
    try {
      skillContent = fs.readFileSync(skillMdPath, "utf-8");
    } catch {
      // Create minimal SKILL.md if it doesn't exist
      skillContent = `# ${skillName}\n`;
    }

    // Inject each pending entry into the appropriate section
    for (const entry of pending) {
      skillContent = this.injectIntoSection(
        skillContent,
        entry.change.section,
        entry.change.content,
      );
      entry.applied = true;
    }

    // Atomic write
    const tmpPath = this.createTempPath(skillMdPath);
    fs.writeFileSync(tmpPath, skillContent, "utf-8");
    fs.renameSync(tmpPath, skillMdPath);

    file.updatedAt = new Date().toISOString();
    this.saveEvolutionFile(skillName, file);

    return pending.length;
  }

  /**
   * Format description-layer experiences as text for prompt injection.
   */
  formatDescriptionExperiences(skillName: string): string {
    const descriptions = this.getExistingDescriptions(skillName);
    if (descriptions.length === 0) return "";

    return [
      `<skill-experiences skill="${skillName}">`,
      "Learned from past usage:",
      ...descriptions.map((d, i) => `${i + 1}. ${d}`),
      "</skill-experiences>",
    ].join("\n");
  }

  /**
   * List all skills that have evolution files.
   */
  listEvolvedSkills(): string[] {
    const skills: string[] = [];
    try {
      const entries = fs.readdirSync(this.skillsBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const evoPath = join(this.skillsBaseDir, entry.name, "evolutions.json");
          if (fs.existsSync(evoPath)) {
            skills.push(entry.name);
          }
        }
      }
    } catch {
      // skills dir may not exist yet
    }
    return skills;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private evolutionFilePath(skillName: string): string {
    return join(this.skillDirPath(skillName), "evolutions.json");
  }

  private skillMdPath(skillName: string): string {
    return join(this.skillDirPath(skillName), "SKILL.md");
  }

  private saveEvolutionFile(skillName: string, file: EvolutionFile): void {
    const dir = this.skillDirPath(skillName);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = this.evolutionFilePath(skillName);
    const tmpPath = this.createTempPath(filePath);
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private skillDirPath(skillName: string): string {
    const normalizedSkillName = skillName.trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(normalizedSkillName)) {
      throw new Error(`Invalid skill name: ${skillName}`);
    }

    const skillDir = resolve(this.skillsBaseDir, normalizedSkillName);
    const basePrefix = this.skillsBaseDir.endsWith(sep)
      ? this.skillsBaseDir
      : `${this.skillsBaseDir}${sep}`;
    if (skillDir !== this.skillsBaseDir && !skillDir.startsWith(basePrefix)) {
      throw new Error(`Invalid skill path for ${skillName}`);
    }

    return skillDir;
  }

  private createTempPath(filePath: string): string {
    return buildAtomicTempPath(filePath);
  }

  /**
   * Inject content into a specific markdown section.
   * Creates the section header if it doesn't exist.
   */
  private injectIntoSection(markdown: string, sectionName: string, content: string): string {
    const trimmedContent = content.trim();
    const headerRegex = new RegExp(`^(##\\s+${sectionName})\\s*$`, "mi");
    const match = headerRegex.exec(markdown);

    if (match) {
      // Section exists: append after header (and any existing content before next section)
      const insertPos = match.index + match[0].length;

      // Find the next section header or end of file
      const restOfFile = markdown.slice(insertPos);
      const nextSectionMatch = /^##\s+/m.exec(restOfFile);

      if (nextSectionMatch) {
        const beforeNext = restOfFile.slice(0, nextSectionMatch.index);
        if (this.sectionAlreadyContains(beforeNext, trimmedContent)) {
          return markdown;
        }
        const afterNext = restOfFile.slice(nextSectionMatch.index);
        return (
          markdown.slice(0, insertPos) +
          beforeNext.trimEnd() +
          "\n\n" +
          trimmedContent +
          "\n\n" +
          afterNext
        );
      }

      // No next section: append at end
      if (this.sectionAlreadyContains(restOfFile, trimmedContent)) {
        return markdown;
      }
      return markdown.trimEnd() + "\n\n" + trimmedContent + "\n";
    }

    // Section doesn't exist: create it at the end
    return markdown.trimEnd() + "\n\n## " + sectionName + "\n\n" + trimmedContent + "\n";
  }

  private sectionAlreadyContains(sectionBody: string, content: string): boolean {
    return sectionBody.replace(/\r\n/g, "\n").includes(content.replace(/\r\n/g, "\n"));
  }

  private resolveMergeIndex(entries: EvolutionEntry[], mergeTarget: string): number {
    const byId = entries.findIndex((entry) => entry.id === mergeTarget);
    if (byId >= 0) {
      return byId;
    }

    if (/^\d+$/.test(mergeTarget)) {
      const index = Number.parseInt(mergeTarget, 10);
      if (index >= 0 && index < entries.length) {
        return index;
      }
    }

    return -1;
  }
}
