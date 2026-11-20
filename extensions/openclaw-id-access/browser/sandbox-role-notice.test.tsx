/* @vitest-environment jsdom */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../ui/src/test-helpers/mount-solid.js";
import { InviteForm } from "./invite-form.js";
import { createPeopleMotion } from "./people-motion.js";
import type { Role, RoleSandboxReadiness } from "./types.js";

type PickerOptions = Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1];

function hostComponents(onPicker: (options: PickerOptions) => void) {
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
      onPicker(initial);
      return { update: onPicker, dispose() {} };
    },
  };
  return components;
}

const guest = (sandbox?: RoleSandboxReadiness): Role => ({
  name: "guest",
  defined: true,
  sessions: "view",
  admin: false,
  requiresSandbox: true,
  ...(sandbox ? { sandbox } : {}),
});
const operator: Role = {
  name: "operator",
  defined: true,
  sessions: "write",
  admin: false,
  requiresSandbox: false,
};

it("blocks inviting to a role whose sandbox cannot start and offers to ask OpenClaw", () => {
  let picker!: PickerOptions;
  const onCreate = vi.fn();
  const [status, setStatus] = createSignal<"idle" | "asking" | "asked" | "failed">("idle");
  const setup = { status, ask: vi.fn(), checkAgain: vi.fn() };
  let setReadiness!: (value: RoleSandboxReadiness | undefined) => void;
  const { container } = mountSolid(() => {
    const [readiness, update] = createSignal<RoleSandboxReadiness | undefined>({
      ready: false,
      reason: "image_missing",
      backend: "docker",
      image: "openclaw-sandbox:trixie-slim",
      doctorBuilds: true,
    });
    setReadiness = update;
    return (
      <InviteForm
        motion={createPeopleMotion()}
        components={hostComponents((options) => (picker = options))}
        roles={[operator, guest(readiness())]}
        disabled={false}
        locale="en-US"
        onCreate={onCreate}
        sandboxSetup={setup}
      />
    );
  });
  flush();
  const notice = () => container.querySelector(".ocid-access__role-notice[role=status]");
  expect(notice()?.textContent).toContain(
    "The guest role needs a sandbox. Its sandbox isn't installed on this claw yet.",
  );
  // The page names no commands or docs detour; setup goes to the owner's agent.
  expect(notice()?.textContent).not.toMatch(/openclaw (doctor|config)|--fix|docker build/);
  expect(notice()?.querySelector("a")).toBeNull();
  const button = (name: string) =>
    [...notice()!.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
  button("Ask OpenClaw to set it up")!.click();
  expect(setup.ask).toHaveBeenCalledWith([expect.objectContaining({ name: "guest" })]);
  setStatus("asked");
  flush();
  expect(notice()?.textContent).toContain(
    "OpenClaw is working on this in the chat beside this page",
  );
  button("Check again")!.click();
  expect(setup.checkAgain).toHaveBeenCalledOnce();
  setStatus("idle");
  flush();
  expect(picker.options.find((option) => option.value === "guest")).toMatchObject({
    disabled: true,
    description: expect.stringContaining("not set up yet"),
  });
  expect(picker.value).toBe("operator");
  picker.onSelect("guest");
  flush();
  expect(picker.value).toBe("operator");

  setReadiness({ ready: false, reason: "engine_unavailable", backend: "podman" });
  flush();
  expect(notice()?.textContent).toContain(
    "Podman isn't running on the computer that hosts this claw.",
  );

  setReadiness({ ready: true });
  flush();
  expect(notice()).toBeNull();
  expect(picker.options.find((option) => option.value === "guest")?.disabled).toBe(false);
  picker.onSelect("guest");
  flush();
  expect(picker.value).toBe("guest");

  // A chosen role that stops being grantable stays chosen and blocks submission, never
  // silently becoming another role.
  const submit = () => container.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  email.value = "guest@example.test";
  email.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(submit().disabled).toBe(false);
  setReadiness({ ready: false, reason: "engine_unavailable", backend: "docker" });
  flush();
  expect(picker.value).toBe("guest");
  expect(submit().disabled).toBe(true);
  setReadiness({ ready: true });
  flush();

  // An unverifiable backend, or People data without readiness, does not block the role.
  setReadiness({ ready: null, backend: "ssh" });
  flush();
  expect(notice()).toBeNull();
  setReadiness(undefined);
  flush();
  expect(notice()).toBeNull();
  expect(picker.value).toBe("guest");
});

it("disables invite creation when every member role is waiting on its sandbox", () => {
  let picker!: PickerOptions;
  const { container } = mountSolid(() => (
    <InviteForm
      motion={createPeopleMotion()}
      components={hostComponents((options) => (picker = options))}
      roles={[
        guest({
          ready: false,
          reason: "image_missing",
          backend: "docker",
          image: "registry.example.test/sandbox:1",
          doctorBuilds: false,
        }),
      ]}
      disabled={false}
      locale="en-US"
      onCreate={vi.fn()}
    />
  ));
  flush();
  expect(picker.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  expect(container.textContent).toContain("Its sandbox isn't installed on this claw yet.");
  // Without an owner's setup handoff (read-only), the notice offers no action.
  expect(container.querySelector(".ocid-access__sandbox-notice button")).toBeNull();
});
