/**
 * Agent Pack types — shareable workspace templates for OpenClaw.
 *
 * An Agent Pack bundles personality (SOUL.md), workspace config (AGENTS.md),
 * skills, and configuration into a versioned, installable template.
 */

/** Metadata parsed from PACK.md frontmatter */
export type PackMetadata = {
  /** Human-readable pack name */
  name: string;
  /** Short summary (one line) */
  description?: string;
  /** Author name or handle */
  author?: string;
  /** Semver version string */
  version?: string;
  /** Skill slugs this pack depends on (auto-install from ClawHub) */
  skills?: string[];
  /** Tags for discovery */
  tags?: string[];
};

/** A resolved pack on disk */
export type PackEntry = {
  /** Absolute path to the pack root directory */
  dir: string;
  /** Absolute path to PACK.md */
  packFilePath: string;
  /** Parsed frontmatter metadata */
  metadata: PackMetadata;
  /** Raw PACK.md content (after frontmatter) */
  description: string;
  /** List of template files (*.template) found in the pack */
  templateFiles: string[];
  /** List of regular (non-template) workspace files found */
  workspaceFiles: string[];
  /** Skill directories bundled in the pack */
  bundledSkillDirs: string[];
};

/** Result of a pack install operation */
export type PackInstallResult = {
  ok: boolean;
  /** Target workspace directory */
  workspaceDir: string;
  /** Files that were copied */
  copiedFiles: string[];
  /** Files that were skipped (already exist and no --force) */
  skippedFiles: string[];
  /** Skills that were installed */
  installedSkills: string[];
  /** Errors encountered */
  errors: string[];
};

/** Options for pack install */
export type PackInstallOptions = {
  /** Target workspace directory (default: new dir based on pack name) */
  workdir?: string;
  /** Overwrite existing files */
  force?: boolean;
  /** Skip skill dependency installation */
  skipSkills?: boolean;
};

/** Options for pack init (export current workspace as pack) */
export type PackInitOptions = {
  /** Pack name */
  name: string;
  /** Output directory for the pack */
  outputDir?: string;
  /** Pack description */
  description?: string;
  /** Pack author */
  author?: string;
  /** Pack version */
  version?: string;
  /** Include skills directory */
  includeSkills?: boolean;
};

/** Result of pack init */
export type PackInitResult = {
  ok: boolean;
  /** Directory where the pack was created */
  packDir: string;
  /** Files included in the pack */
  files: string[];
  /** Errors encountered */
  errors: string[];
};
