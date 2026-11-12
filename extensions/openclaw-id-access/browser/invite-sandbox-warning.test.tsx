/* @vitest-environment jsdom */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../ui/src/test-helpers/mount-solid.js";
import { createPeopleMotion } from "./people-motion.js";
import { InviteForm } from "./people-sections.js";

it("warns from the selected role's catalog policy and tracks backend and definition changes", () => {
  let selectRole: (role: string) => void = () => {};
  const unused = () => {
    throw new Error("unused host component");
  };
  const components: ControlUiHost["components"] = {
    resolveAppearanceColor: unused,
    mountAgentAvatar: unused,
    mountAppearancePicker: unused,
    mountAppearanceGlyph: unused,
    mountDialog: unused,
    mountAgentPicker: unused,
    mountSessionSummary: unused,
    mountDashboard: unused,
    mountSelectPicker: (_container, initial) => {
      selectRole = initial.onSelect;
      return {
        update(next) {
          selectRole = next.onSelect;
        },
        dispose() {},
      };
    },
  };
  let setAvailable!: (value: boolean | null) => void;
  let setRequiresSandbox!: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [available, updateAvailable] = createSignal<boolean | null>(false);
    const [requiresSandbox, updateRequiresSandbox] = createSignal(true);
    setAvailable = updateAvailable;
    setRequiresSandbox = updateRequiresSandbox;
    return (
      <InviteForm
        motion={createPeopleMotion()}
        components={components}
        disabled={false}
        locale="en-US"
        onCreate={vi.fn()}
        link={{
          linked: true,
          roles: [
            { name: "operator", defined: true, requiresSandbox: false },
            { name: "viewer", defined: true, requiresSandbox: requiresSandbox() },
          ],
          sandboxBackend: { backend: "docker", available: available() },
        }}
      />
    );
  });
  flush();
  const warning = () => container.querySelector('[role="status"]');
  expect(warning()).toBeNull();
  selectRole("viewer");
  flush();
  expect(warning()?.textContent).toContain(
    "Members with this role cannot run anything until a sandbox backend is set up",
  );
  expect(warning()?.querySelector("a")?.getAttribute("href")).toBe(
    "https://docs.openclaw.ai/gateway/sandboxing",
  );
  setAvailable(true);
  flush();
  expect(warning()).toBeNull();
  setAvailable(null);
  flush();
  expect(warning()).toBeNull();
  setAvailable(false);
  flush();
  expect(warning()).not.toBeNull();
  setRequiresSandbox(false);
  flush();
  expect(warning()).toBeNull();
});

it("uses custom role names and stays quiet for undefined roles or absent people data", async () => {
  const { InviteSandboxWarning } = await import("./invite-sandbox-warning.js");
  let setRole!: (value: string | undefined) => void;
  let setDefined!: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [role, updateRole] = createSignal<string | undefined>("researcher");
    const [defined, updateDefined] = createSignal(true);
    setRole = updateRole;
    setDefined = updateDefined;
    return (
      <InviteSandboxWarning
        role={role()}
        link={{
          roles: [{ name: "researcher", defined: defined(), requiresSandbox: true }],
          sandboxBackend: { backend: "podman", available: false },
        }}
      />
    );
  });
  flush();
  expect(container.textContent).toContain("Members with this role cannot run anything");
  setDefined(false);
  flush();
  expect(container.textContent).toBe("");
  setDefined(true);
  setRole("different");
  flush();
  expect(container.textContent).toBe("");
  setRole(undefined);
  flush();
  expect(container.textContent).toBe("");
  expect(mountSolid(() => <InviteSandboxWarning role="researcher" />).container.textContent).toBe(
    "",
  );
});
