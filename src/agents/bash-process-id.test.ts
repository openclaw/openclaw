import { describe, expect, it } from "vitest";
import { createProcessSessionId, missingProcessMessage } from "./bash-process-id.js";

function currentBootSuffix(): string {
  const suffix = createProcessSessionId().split(":").at(-1);
  if (!suffix) {
    throw new Error("generated process session ID has no boot suffix");
  }
  return suffix;
}

describe("missingProcessMessage", () => {
  it("explains that a bare name is not a tracked session ID", () => {
    const message = missingProcessMessage("session");

    expect(message).toContain("Process session is not a tracked session ID");
    expect(message).toContain("boot suffix");
    expect(message).toContain("process list");
    expect(message).not.toContain("Gateway restarts");
    expect(message).not.toContain("rerun it");
  });

  it("keeps restart guidance for a boot-qualified ID from another boot", () => {
    const otherBoot = currentBootSuffix() === "000000000000" ? "111111111111" : "000000000000";

    expect(missingProcessMessage(`session:${otherBoot}`)).toContain(
      "was started before the Gateway restarted",
    );
  });

  it("keeps the generic message for a current-boot ID", () => {
    const id = createProcessSessionId();
    const message = missingProcessMessage(id);

    expect(message).toContain("is no longer tracked or is outside this session's scope");
    expect(message).not.toContain("Gateway restarts");
  });
});
