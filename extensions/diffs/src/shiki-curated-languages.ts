const javascript = () => import("@shikijs/langs/javascript");
const typescript = () => import("@shikijs/langs/typescript");
const tsx = () => import("@shikijs/langs/tsx");
const jsx = () => import("@shikijs/langs/jsx");
const json = () => import("@shikijs/langs/json");
const markdown = () => import("@shikijs/langs/markdown");
const yaml = () => import("@shikijs/langs/yaml");
const css = () => import("@shikijs/langs/css");
const html = () => import("@shikijs/langs/html");
const sh = () => import("@shikijs/langs/sh");
const python = () => import("@shikijs/langs/python");
const go = () => import("@shikijs/langs/go");
const rust = () => import("@shikijs/langs/rust");
const java = () => import("@shikijs/langs/java");
const c = () => import("@shikijs/langs/c");
const cpp = () => import("@shikijs/langs/cpp");
const csharp = () => import("@shikijs/langs/csharp");
const php = () => import("@shikijs/langs/php");
const sql = () => import("@shikijs/langs/sql");
const docker = () => import("@shikijs/langs/docker");

export const bundledLanguagesInfo = [
  { id: "javascript", name: "JavaScript", aliases: ["js", "mjs", "cjs"], import: javascript },
  { id: "typescript", name: "TypeScript", aliases: ["ts", "mts", "cts"], import: typescript },
  { id: "tsx", name: "TSX", import: tsx },
  { id: "jsx", name: "JSX", import: jsx },
  { id: "json", name: "JSON", aliases: ["jsonc", "json5", "jsonl"], import: json },
  { id: "markdown", name: "Markdown", aliases: ["md"], import: markdown },
  { id: "yaml", name: "YAML", aliases: ["yml"], import: yaml },
  { id: "css", name: "CSS", import: css },
  { id: "html", name: "HTML", import: html },
  { id: "sh", name: "Shell", aliases: ["bash", "shell", "shellscript", "zsh"], import: sh },
  { id: "python", name: "Python", aliases: ["py"], import: python },
  { id: "go", name: "Go", import: go },
  { id: "rust", name: "Rust", aliases: ["rs"], import: rust },
  { id: "java", name: "Java", import: java },
  { id: "c", name: "C", import: c },
  { id: "cpp", name: "C++", aliases: ["c++"], import: cpp },
  { id: "csharp", name: "C#", aliases: ["cs"], import: csharp },
  { id: "php", name: "PHP", import: php },
  { id: "sql", name: "SQL", import: sql },
  { id: "docker", name: "Docker", aliases: ["dockerfile"], import: docker },
] as const;

export const bundledLanguagesBase = Object.fromEntries(
  bundledLanguagesInfo.map((language) => [language.id, language.import]),
);
export const bundledLanguagesAlias = Object.fromEntries(
  bundledLanguagesInfo.flatMap(
    (language) => language.aliases?.map((alias) => [alias, language.import]) ?? [],
  ),
);
export const bundledLanguages = {
  ...bundledLanguagesBase,
  ...bundledLanguagesAlias,
};
