import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_BLAST_RADIUS_REGISTRY,
  DESTRUCTIVE_ACTION_PATTERNS,
  classifyDestructiveAction,
  extractTextSegments,
  classifyCredentialBlastRadiusName,
  inventoryCredentialBlastRadius,
} from "./credential-blast-radius-classifier.js";

describe("DESTRUCTIVE_ACTION_PATTERNS — registry sanity", () => {
  it("every pattern has a unique id", () => {
    const ids = DESTRUCTIVE_ACTION_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every pattern has a valid severity", () => {
    for (const p of DESTRUCTIVE_ACTION_PATTERNS) {
      expect(["block", "require-approval"]).toContain(p.severity);
    }
  });

  it("every pattern regex is valid and does not throw on empty string", () => {
    for (const p of DESTRUCTIVE_ACTION_PATTERNS) {
      expect(() => p.pattern.exec("")).not.toThrow();
    }
  });
});

describe("CREDENTIAL_BLAST_RADIUS_REGISTRY — registry sanity", () => {
  it("every entry has a unique name", () => {
    const names = CREDENTIAL_BLAST_RADIUS_REGISTRY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry has a valid class", () => {
    const validClasses = ["critical", "high", "medium", "low"];
    for (const e of CREDENTIAL_BLAST_RADIUS_REGISTRY) {
      expect(validClasses).toContain(e.class);
    }
  });

  it("known critical credentials are classified correctly", () => {
    const registry = Object.fromEntries(
      CREDENTIAL_BLAST_RADIUS_REGISTRY.map((e) => [e.name, e.class]),
    );
    expect(registry["SUPABASE_SERVICE_ROLE_KEY"]).toBe("critical");
    expect(registry["SUPABASE_SERVICE_KEY"]).toBe("critical");
    expect(registry["GH_TOKEN"]).toBe("critical");
    expect(registry["GITHUB_TOKEN"]).toBe("critical");
    expect(registry["VERCEL_TOKEN"]).toBe("critical");
  });

  it("known high and critical platform credentials are classified correctly", () => {
    const registry = Object.fromEntries(
      CREDENTIAL_BLAST_RADIUS_REGISTRY.map((e) => [e.name, e.class]),
    );
    expect(registry["SUPABASE_ACCESS_TOKEN"]).toBe("high");
    expect(registry["RAILWAY_TOKEN"]).toBe("high");
    expect(registry["AWS_ACCESS_KEY_ID"]).toBe("high");
    expect(registry["DIGITALOCEAN_API_TOKEN"]).toBe("critical");
    expect(registry["BREX_API_TOKEN"]).toBe("critical");
    expect(registry["AUTH_TOKEN"]).toBe("high");
  });

  it("known integration tokens are classified explicitly", () => {
    const registry = Object.fromEntries(
      CREDENTIAL_BLAST_RADIUS_REGISTRY.map((e) => [e.name, e.class]),
    );
    expect(registry["SLACK_BOT_TOKEN"]).toBe("medium");
    expect(registry["SLACK_USER_TOKEN"]).toBe("high");
    expect(registry["DISCORD_BOT_TOKEN"]).toBe("medium");
    expect(registry["MARA_DISCORD_TOKEN"]).toBe("high");
    expect(registry["EXPO_TOKEN"]).toBe("medium");
    expect(registry["FIGMA_ACCESS_TOKEN"]).toBe("medium");
    expect(registry["FIGMA_API_TOKEN"]).toBe("medium");
    expect(registry["NOTION_API_KEY"]).toBe("medium");
    expect(registry["MAILJET_API_KEY"]).toBe("medium");
    expect(registry["MAILJET_SECRET_KEY"]).toBe("high");
  });

  it("model API keys are classified as low", () => {
    const registry = Object.fromEntries(
      CREDENTIAL_BLAST_RADIUS_REGISTRY.map((e) => [e.name, e.class]),
    );
    expect(registry["ANTHROPIC_API_KEY"]).toBe("low");
    expect(registry["OPENAI_API_KEY"]).toBe("low");
  });
});

describe("classifyCredentialBlastRadiusName", () => {
  it("returns explicit registry classification for known names", () => {
    expect(classifyCredentialBlastRadiusName("SUPABASE_SERVICE_KEY")?.class).toBe("critical");
    expect(classifyCredentialBlastRadiusName("DIGITALOCEAN_API_TOKEN")?.class).toBe("critical");
    expect(classifyCredentialBlastRadiusName("BREX_API_TOKEN")?.class).toBe("critical");
    expect(classifyCredentialBlastRadiusName("SLACK_BOT_TOKEN")?.class).toBe("medium");
    expect(classifyCredentialBlastRadiusName("MARA_DISCORD_TOKEN")?.class).toBe("high");
  });

  it("conservatively classifies unknown credential-like suffixes as high", () => {
    expect(classifyCredentialBlastRadiusName("ACME_TOKEN")?.class).toBe("high");
    expect(classifyCredentialBlastRadiusName("ACME_SECRET")?.class).toBe("high");
    expect(classifyCredentialBlastRadiusName("ACME_API_KEY")?.class).toBe("high");
  });

  it("returns undefined for non-credential-like names", () => {
    expect(classifyCredentialBlastRadiusName("PATH")).toBeUndefined();
    expect(classifyCredentialBlastRadiusName("HOME")).toBeUndefined();
  });
});

describe("extractTextSegments", () => {
  it("returns empty array for null", () => {
    expect(extractTextSegments(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(extractTextSegments(undefined)).toEqual([]);
  });

  it("returns empty array for a number", () => {
    expect(extractTextSegments(42)).toEqual([]);
  });

  it("returns empty array for an array", () => {
    expect(extractTextSegments(["a", "b"])).toEqual([]);
  });

  it("wraps a bare string param in an array", () => {
    expect(extractTextSegments("DROP DATABASE foo")).toEqual(["DROP DATABASE foo"]);
  });

  it("extracts the command field", () => {
    const segs = extractTextSegments({ command: "rm -rf ~", cwd: "/tmp" });
    expect(segs).toContain("rm -rf ~");
    expect(segs).not.toContain("/tmp");
  });

  it("ignores numeric fields", () => {
    const segs = extractTextSegments({ command: "ls", timeout: 5000 });
    expect(segs).toEqual(["ls"]);
  });

  it("extracts sql field", () => {
    const segs = extractTextSegments({ sql: "DROP TABLE users" });
    expect(segs).toContain("DROP TABLE users");
  });

  it("extracts body and url fields", () => {
    const segs = extractTextSegments({
      url: "https://api.railway.app/graphql",
      body: '{"query":"mutation { volumeDelete(id:\\"v\\") }"}',
    });
    expect(segs).toContain("https://api.railway.app/graphql");
    expect(segs).toContain('{"query":"mutation { volumeDelete(id:\\"v\\") }"}');
  });

  it("extracts code field", () => {
    const segs = extractTextSegments({ code: "supabase db reset" });
    expect(segs).toContain("supabase db reset");
  });

  it("does not extract unrecognized field names", () => {
    const segs = extractTextSegments({ filepath: "DROP TABLE users", irrelevant: "foo" });
    expect(segs).toEqual([]);
  });
});

describe("classifyDestructiveAction — safe commands", () => {
  it("returns isDestructive=false for a safe ls command", () => {
    expect(classifyDestructiveAction("bash", { command: "ls -la /tmp" }).isDestructive).toBe(false);
  });

  it("returns isDestructive=false for empty object params", () => {
    expect(classifyDestructiveAction("bash", {}).isDestructive).toBe(false);
  });

  it("returns isDestructive=false for null params", () => {
    expect(classifyDestructiveAction("bash", null).isDestructive).toBe(false);
  });

  it("returns isDestructive=false for git commit", () => {
    expect(
      classifyDestructiveAction("bash", { command: "git commit -m 'fix'" }).isDestructive,
    ).toBe(false);
  });

  it("does not falsely match 'dropbox' as DROP DATABASE", () => {
    expect(classifyDestructiveAction("bash", { command: "open dropbox" }).isDestructive).toBe(
      false,
    );
  });

  it("does not falsely match 'truncated' as TRUNCATE", () => {
    expect(
      classifyDestructiveAction("bash", { command: "echo truncated output" }).isDestructive,
    ).toBe(false);
  });
});

describe("classifyDestructiveAction — Railway", () => {
  it("detects volumeDelete in GraphQL body", () => {
    const result = classifyDestructiveAction("web.fetch", {
      url: "https://backboard.railway.com/graphql/v2",
      body: '{"query":"mutation volumeDeleteMutation { volumeDelete(id:\\"123\\") }"}',
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "railway/volumeDelete")).toBe(true);
      expect(result.highestSeverity).toBe("block");
    }
  });

  it("detects railway volume delete CLI command", () => {
    const result = classifyDestructiveAction("bash", { command: "railway volume delete vol-123" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "railway/service-delete")).toBe(true);
    }
  });
});

describe("classifyDestructiveAction — SQL", () => {
  it("detects DROP DATABASE in psql command", () => {
    const result = classifyDestructiveAction("bash", { command: "psql -c 'DROP DATABASE prod'" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "sql/drop-database")).toBe(true);
      expect(result.highestSeverity).toBe("block");
    }
  });

  it("is case-insensitive for DROP DATABASE", () => {
    const result = classifyDestructiveAction("bash", { command: "drop database mydb" });
    expect(result.isDestructive).toBe(true);
  });

  it("detects DROP TABLE (require-approval)", () => {
    const result = classifyDestructiveAction("bash", { command: "DROP TABLE users" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "sql/drop-table")).toBe(true);
      expect(result.highestSeverity).toBe("require-approval");
    }
  });

  it("detects TRUNCATE TABLE (require-approval)", () => {
    const result = classifyDestructiveAction("bash", { command: "TRUNCATE TABLE logs" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "sql/truncate")).toBe(true);
      expect(result.highestSeverity).toBe("require-approval");
    }
  });

  it("highestSeverity is block when DROP DATABASE accompanies DROP TABLE", () => {
    const result = classifyDestructiveAction("bash", {
      command: "DROP TABLE staging; DROP DATABASE prod",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.highestSeverity).toBe("block");
    }
  });
});

describe("classifyDestructiveAction — Supabase", () => {
  it("detects supabase db reset", () => {
    const result = classifyDestructiveAction("bash", { command: "supabase db reset --local" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "supabase/db-reset")).toBe(true);
      expect(result.highestSeverity).toBe("block");
    }
  });

  it("detects supabase project delete", () => {
    const result = classifyDestructiveAction("bash", {
      command: "supabase projects delete my-project",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "supabase/project-delete")).toBe(true);
    }
  });
});

describe("classifyDestructiveAction — Vercel", () => {
  it("detects vercel remove", () => {
    const result = classifyDestructiveAction("bash", { command: "vercel remove my-project" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "vercel/remove")).toBe(true);
    }
  });

  it("detects vercel rm", () => {
    const result = classifyDestructiveAction("bash", { command: "vercel rm my-project" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "vercel/project-rm")).toBe(true);
    }
  });

  it("detects vercel env rm (require-approval)", () => {
    const result = classifyDestructiveAction("bash", {
      command: "vercel env rm MY_SECRET production",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "vercel/env-rm")).toBe(true);
      expect(result.highestSeverity).toBe("require-approval");
    }
  });
});

describe("classifyDestructiveAction — GitHub", () => {
  it("detects gh repo delete", () => {
    const result = classifyDestructiveAction("bash", {
      command: "gh repo delete myorg/myrepo --yes",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "github/repo-delete")).toBe(true);
      expect(result.highestSeverity).toBe("block");
    }
  });

  it("detects gh org delete", () => {
    const result = classifyDestructiveAction("bash", { command: "gh org delete myorg" });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "github/org-delete")).toBe(true);
    }
  });
});

describe("classifyDestructiveAction — AWS", () => {
  it("detects aws ec2 terminate-instances", () => {
    const result = classifyDestructiveAction("bash", {
      command: "aws ec2 terminate-instances --instance-ids i-1234",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "aws/terminate-instances")).toBe(true);
    }
  });

  it("detects aws rds delete-db-instance", () => {
    const result = classifyDestructiveAction("bash", {
      command: "aws rds delete-db-instance --db-instance-identifier mydb",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "aws/rds-delete")).toBe(true);
    }
  });

  it("detects aws s3 rb", () => {
    const result = classifyDestructiveAction("bash", {
      command: "aws s3 rb s3://my-bucket --force",
    });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "aws/s3-rb")).toBe(true);
    }
  });
});

describe("classifyDestructiveAction — shell", () => {
  it.each([
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~/",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -rf $HOME/*",
    'rm -rf "$HOME"/*',
    "rm -rf ${HOME}/",
    "rm -rf ${HOME}/*",
    "rm -rf '${HOME}'/*",
    "rm -rf ${HOME:?}/*",
    "rm -rf ~/*",
    "rm -rf / --no-preserve-root",
    "rm --recursive -- /",
  ])("detects catastrophic rm -r target: %s", (command) => {
    const result = classifyDestructiveAction("bash", { command });
    expect(result.isDestructive).toBe(true);
    if (result.isDestructive) {
      expect(result.matches.some((m) => m.patternId === "shell/rm-rf-root")).toBe(true);
    }
  });

  it.each([
    "rm -rf /tmp/openclaw-build",
    "rm -rf /home/openclaw/some-specific-dir",
    "rm -rf ~/important-dir",
    "rm -rf $HOME/important-dir",
  ])("does not block specific absolute/home cleanup target: %s", (command) => {
    const result = classifyDestructiveAction("bash", { command });
    expect(result.isDestructive).toBe(false);
  });
});

describe("inventoryCredentialBlastRadius", () => {
  it("returns empty array when no known credentials are present", () => {
    expect(inventoryCredentialBlastRadius({})).toEqual([]);
  });

  it("ignores non-credential unknown names", () => {
    expect(inventoryCredentialBlastRadius({ SOME_UNKNOWN_KEY: "value" })).toEqual([]);
  });

  it("includes unknown credential-like names via the generic conservative strategy", () => {
    const result = inventoryCredentialBlastRadius({ ACME_PROD_TOKEN: "set" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("ACME_PROD_TOKEN");
    expect(result[0]?.class).toBe("high");
  });

  it("identifies SUPABASE_SERVICE_ROLE_KEY as critical", () => {
    const result = inventoryCredentialBlastRadius({ SUPABASE_SERVICE_ROLE_KEY: "set" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("SUPABASE_SERVICE_ROLE_KEY");
    expect(result[0]?.class).toBe("critical");
  });

  it("identifies GH_TOKEN as critical", () => {
    const result = inventoryCredentialBlastRadius({ GH_TOKEN: "set" });
    expect(result[0]?.class).toBe("critical");
  });

  it("identifies multiple credentials and their classes", () => {
    const env = {
      GH_TOKEN: "set",
      VERCEL_TOKEN: "set",
      ANTHROPIC_API_KEY: "set",
    };
    const result = inventoryCredentialBlastRadius(env);
    const byName = Object.fromEntries(result.map((e) => [e.name, e]));
    expect(byName["GH_TOKEN"]?.class).toBe("critical");
    expect(byName["VERCEL_TOKEN"]?.class).toBe("critical");
    expect(byName["ANTHROPIC_API_KEY"]?.class).toBe("low");
  });

  it("ignores keys whose value is undefined", () => {
    const result = inventoryCredentialBlastRadius({
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });
    expect(result).toHaveLength(0);
  });

  it("never returns credential values — only names and metadata", () => {
    const result = inventoryCredentialBlastRadius({ GH_TOKEN: "super-secret-token-value" });
    const json = JSON.stringify(result);
    expect(json).not.toContain("super-secret-token-value");
  });

  it("output contains only name, class, and description fields", () => {
    const result = inventoryCredentialBlastRadius({ BRAVE_API_KEY: "set" });
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry).toBeDefined();
    if (entry) {
      expect(Object.keys(entry).toSorted()).toEqual(["class", "description", "name"]);
    }
  });
});
