import fs from "node:fs/promises";
import path from "node:path";

export async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
  frontmatterExtra?: string;
}) {
  const { dir, name, description, metadata, body, frontmatterExtra } = params;
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = [
    `name: ${name}`,
    `description: ${description}`,
    metadata ? `metadata: ${metadata}` : "",
    frontmatterExtra ?? "",
  ]
    .filter((line) => line.trim().length > 0)
    .join("\n");
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}
