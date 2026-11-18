import codexPackage from "../../codex/package.json" with { type: "json" };

export const BUNDLED_CODEX_VERSION = codexPackage.dependencies["@openai/codex"];
