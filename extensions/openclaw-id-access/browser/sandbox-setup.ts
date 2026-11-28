// Hands sandbox setup for roles that cannot be granted yet to the owner's own agent, in a
// conversation docked beside the Access page. The agent decides how; this page only describes
// what the Gateway reported.
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { roleName } from "./people-format.js";
import type { Role } from "./types.js";

type SetupHost = Pick<ControlUiHost, "agents" | "dock" | "request" | "sessions">;

function problem(role: Role): string | undefined {
  const readiness = role.defined ? role.sandbox : undefined;
  if (readiness?.ready !== false) {
    return undefined;
  }
  const name = roleName(role.name);
  const engine = readiness.backend === "podman" ? "Podman" : "Docker";
  return readiness.reason === "engine_unavailable"
    ? `- The ${name} role requires a sandbox, but the ${engine} sandbox backend is not reachable from this Gateway.`
    : `- The ${name} role requires a sandbox, but the sandbox image ${readiness.image} is missing from ${engine}.${
        readiness.doctorBuilds
          ? " It is OpenClaw's default sandbox image."
          : " It is a custom image configured for this claw."
      }`;
}

/** The request the owner sends their agent; plain facts from the Gateway's readiness check. */
function sandboxSetupPrompt(roles: readonly Role[]): string {
  return [
    "Please set up sandboxing on this claw so I can invite people with these roles from the Access page.",
    "",
    "The Access page reports:",
    ...roles.flatMap((role) => problem(role) ?? []),
    "",
    "Check what is needed and tell me what you will change on this computer before you change it. When you are done, confirm that the sandbox works so I can check again on the Access page.",
  ].join("\n");
}

/**
 * Starts a new conversation with the default agent, sends the setup request, and docks it
 * beside the page (or opens it when the host has no dock). Resolves once the request is sent.
 */
export async function askAgentToSetUpSandbox(host: SetupHost, roles: readonly Role[]) {
  const agentId = host.agents.defaultId ?? host.agents.selectedId;
  if (!agentId) {
    throw new Error("No agent is available to set up the sandbox.");
  }
  const sessionKey = await host.sessions.create({
    agentId,
    displayName: "Sandbox setup",
    ...(host.dock ? { surface: "plugin-dock" as const } : {}),
  });
  if (!sessionKey) {
    throw new Error("The setup conversation could not be created.");
  }
  await host.request("chat.send", {
    sessionKey,
    agentId,
    message: sandboxSetupPrompt(roles),
    idempotencyKey: `access-sandbox-setup:${sessionKey}`,
  });
  if (host.dock) {
    host.dock.openSession({
      sessionKey,
      agentId,
      label: "Sandbox setup",
      context: { page: "access" },
    });
  } else {
    host.sessions.open({ sessionKey, agentId });
  }
}
