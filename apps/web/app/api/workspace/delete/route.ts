import { spawn } from "node:child_process";
import { discoverProfiles, getEffectiveProfile, resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DELETE_TIMEOUT_MS = 2 * 60_000;

type SpawnResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function normalizeProfileName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.toLowerCase() === "default") {
    return "default";
  }
  if (!PROFILE_NAME_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function resolveCommandForPlatform(command: string): string {
  if (process.platform === "win32" && !command.toLowerCase().endsWith(".cmd")) {
    return `${command}.cmd`;
  }
  return command;
}

function firstNonEmptyLine(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const first = value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  return undefined;
}

async function runWorkspaceDelete(profile: string): Promise<SpawnResult> {
  const args = ["--profile", profile, "workspace", "delete"];
  return await new Promise<SpawnResult>((resolveResult, reject) => {
    const child = spawn(resolveCommandForPlatform("openclaw"), args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, DELETE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
      });
    });

    // For commands that prompt for confirmation.
    child.stdin?.write("y\n");
    child.stdin?.write("yes\n");
    child.stdin?.end();
  });
}

function looksLikeUnknownCommandOutput(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`;
  return (
    text.includes("Usage: openclaw [options] [command]") &&
    text.includes("Hint: commands suffixed with * have subcommands")
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { profile?: unknown };
  const profile = normalizeProfileName(body.profile);
  if (!profile) {
    return Response.json(
      { error: "Invalid profile name. Use letters, numbers, hyphens, or underscores." },
      { status: 400 },
    );
  }

  const availableProfile = discoverProfiles().find((candidate) => candidate.name === profile);
  if (!availableProfile) {
    return Response.json(
      { error: `Profile '${profile}' was not found.` },
      { status: 404 },
    );
  }
  if (!availableProfile.workspaceDir) {
    return Response.json(
      { error: `Profile '${profile}' does not have a workspace to delete.` },
      { status: 409 },
    );
  }

  try {
    const result = await runWorkspaceDelete(profile);
    if (looksLikeUnknownCommandOutput(result.stdout, result.stderr)) {
      return Response.json(
        { error: "This OpenClaw installation does not support `workspace delete`." },
        { status: 501 },
      );
    }
    if (result.code !== 0) {
      const detail = firstNonEmptyLine(result.stderr, result.stdout);
      return Response.json(
        {
          error: detail
            ? `Workspace delete failed: ${detail}`
            : "Workspace delete command failed.",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    const message = (error as Error).message || "Workspace delete command failed.";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({
    deleted: true,
    profile,
    activeProfile: getEffectiveProfile() ?? "default",
    workspaceRoot: resolveWorkspaceRoot(),
  });
}
