import { describe, expect, it } from "vitest";
import { createRbacGuard } from "../../claworks/robot-identity.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { checkMcpToolAuth, mcpToolWriteResource } from "./mcp-auth.js";

function runtimeWithRbac(): ClaworksRuntime {
  return {
    rbac: createRbacGuard([]),
    config: { api: { api_key: "secret" } },
  } as unknown as ClaworksRuntime;
}

describe("mcp-auth", () => {
  it("maps write tools to REST resources", () => {
    expect(mcpToolWriteResource("cw_trigger_playbook", { playbook_id: "diag" })).toBe(
      "playbook:diag",
    );
    expect(mcpToolWriteResource("cw_publish_event", { event_type: "alarm.created" })).toBe(
      "alarm.created",
    );
  });

  it("allows read tools without rest.write", () => {
    const runtime = runtimeWithRbac();
    const auth = { authenticated: true, subjectType: "apikey" as const, subjectId: "unknown" };
    expect(checkMcpToolAuth(runtime, auth, "cw_kb_search", { query: "x" }).allowed).toBe(true);
    expect(checkMcpToolAuth(runtime, auth, "cw_kb_list_documents", {}).allowed).toBe(true);
    expect(
      checkMcpToolAuth(runtime, auth, "cw_kb_lint_document", { document_id: "d1" }).allowed,
    ).toBe(true);
  });

  it("maps document KB write tools to ingest/publish resources", () => {
    expect(mcpToolWriteResource("cw_kb_ingest_document", {})).toBe("kb:ingest");
    expect(mcpToolWriteResource("cw_kb_publish", {})).toBe("kb:publish");
    expect(mcpToolWriteResource("cw_kb_process_ingest_job", {})).toBe("kb:ingest");
  });

  it("denies rest.write tools for unknown apikey subject", () => {
    const runtime = runtimeWithRbac();
    const auth = { authenticated: true, subjectType: "apikey" as const, subjectId: "unknown" };
    const result = checkMcpToolAuth(runtime, auth, "cw_kb_ingest", { text: "x" });
    expect(result.allowed).toBe(false);
  });

  it("allows write tools for local system subject", () => {
    const runtime = runtimeWithRbac();
    const auth = { authenticated: true, subjectType: "system" as const, subjectId: "local" };
    expect(
      checkMcpToolAuth(runtime, auth, "cw_trigger_playbook", { playbook_id: "diag" }).allowed,
    ).toBe(true);
  });
});
