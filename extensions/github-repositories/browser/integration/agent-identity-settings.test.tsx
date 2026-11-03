/** @jsxImportSource @solidjs/web */
import { createComponent, createMemo } from "solid-js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { SolidBridgeElement } from "../../../../ui/src/lib/solid-bridge.ts";
import { mountSolid as mountConnected } from "../../../../ui/src/test-helpers/mount-solid.ts";
import { cleanupSolid } from "../../../../ui/src/test-helpers/solid-cleanup.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../../ui/src/test-helpers/solid-settle.ts";
import {
  availableIdentity,
  createIdentityFixture,
} from "./github-identity-harness.test-support.ts";
import { githubIdentityViewFixture } from "./github-identity.test-support.ts";
import { GitHubIdentity } from "./github-settings.test-support.tsx";

afterEach(cleanupSolid);
const content = (root: Element, selector: string) =>
  root.querySelector(selector)?.textContent?.trim();
const button = (root: Element, label: string) => {
  const control = Array.from(root.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
  assert(control, `Missing control: ${label}`);
  return control;
};
function renderIdentitySettings(identity: Parameters<typeof GitHubIdentity>[0]["identity"]) {
  return () => createComponent(GitHubIdentity, { identity, onOpenConnections: vi.fn() });
}
function Settings(props: { renderSettings: () => ReturnType<typeof GitHubIdentity> }) {
  const renderedSettings = createMemo(() => props.renderSettings());
  return <>{renderedSettings()}</>;
}
const mountIdentity = (props: Parameters<typeof Settings>[0]) => mountSolid(Settings, props);

function agentIdentity(client: Parameters<typeof createIdentityFixture>[0]) {
  const { identity, sync } = createIdentityFixture(
    client,
    {
      runExternalMutation: async () => ({ ok: false, reason: "unavailable", error: "not used" }),
    },
    { scope: "agent" },
  );
  sync();
  return identity;
}

async function settleGitHubIdentity(container: HTMLElement) {
  if (!container.isConnected) {
    mountConnected(() => container);
  }
  const bridge = container.querySelector<SolidBridgeElement<object>>("openclaw-github-identity");
  assert(bridge, "Missing GitHub identity bridge");
  await bridge.updateComplete;
}

describe("GitHub agent identity settings", () => {
  it.each([false, true])(
    "renders effective GitHub facts without credential controls (inherited: %s)",
    async (inherited) => {
      const effective = inherited
        ? {
            ...availableIdentity,
            source: "system-configured" as const,
            account: { login: "system-user" },
            gitAuthor: { name: "System Author", email: "system@example.com" },
            oauthScopes: ["repo", "workflow"],
          }
        : {
            ...availableIdentity,
            source: "system-detected" as const,
            credentialKind: "native" as const,
            account: { login: "octocat" },
            gitAuthor: { name: null, email: null },
            accessExpiresAtMs: null,
            refreshState: "not_applicable" as const,
            oauthScopes: [],
          };
      const scope = inherited ? "agent" : "system";
      const { container } = mountIdentity({
        renderSettings: renderIdentitySettings(
          githubIdentityViewFixture({
            status: {
              agentId: "main",
              selectedScope: scope,
              selected: { scope, configured: false, identity: inherited ? null : effective },
              effective,
            },
          }),
        ),
      });
      await settleGitHubIdentity(container);

      const section = container.querySelector("openclaw-github-identity");
      assert(section, "Missing GitHub identity section");
      expect(section.textContent).toContain(inherited ? "@system-user" : "@octocat");
      expect(content(section, ".settings-status")).toBe("Verified");
      const details = section.querySelector<HTMLButtonElement>(
        'button[aria-label="Connection details"]',
      );
      assert(details, "Missing connection details button");
      details.click();
      await waitForSolid(() => {
        const authorRow = Array.from(section.querySelectorAll(".settings-row")).find((row) =>
          row.querySelector(".settings-row__title")?.textContent?.includes("Git Author"),
        );
        expect(authorRow?.querySelector(".settings-row__value")?.textContent?.trim()).toBe(
          inherited ? "System Author · system@example.com" : "Not set",
        );
      });
      if (inherited) {
        expect(section.textContent).toContain("Managed GitHub authorization");
        expect(section.textContent).toContain("repo, workflow");
        expect(section.textContent).toContain("System GitHub");
      }
      expect(section.querySelector(".settings-secret input")).toBeNull();
      expect(section.textContent).toContain("Manage connections in Profile");
      expect(section.textContent).not.toMatch(
        /system-detected|github-api|OS account running the Gateway|Advanced: agent GitHub override/,
      );
    },
  );

  it("renders only the pinned device link and one-time code while authorization is active", async () => {
    const container = document.createElement("div");
    const client = {
      request: vi.fn(async () => ({
        requestId: "github-device-11111111111111111111111111111111",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresInMs: 900_000,
        pollAfterMs: 60_000,
      })),
    } as never;
    const githubIdentity = agentIdentity(client);
    await githubIdentity.startAuthorization();

    mountSolid(Settings, { renderSettings: renderIdentitySettings(githubIdentity) }, container);
    await settleGitHubIdentity(container);

    expect(container.textContent).toContain("ABCD-1234");
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/login/device"]',
    );
    expect(link?.textContent?.trim()).toBe("Open github.com/login/device");
    expect(link?.target).toBe("_blank");
    expect(link?.rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(container.querySelector(".settings-secret input")).toBeNull();
    expect(container.textContent).not.toContain("github-device-11111111111111111111111111111111");
    githubIdentity.dispose();
  });

  it("keeps PAT fields hidden until the explicit fallback is selected", async () => {
    const container = document.createElement("div");
    const client = { request: vi.fn() } as never;
    const githubIdentity = agentIdentity(client);

    const view = mountSolid(
      Settings,
      { renderSettings: renderIdentitySettings(githubIdentity) },
      container,
    );
    await settleGitHubIdentity(container);
    expect(container.querySelector(".settings-secret input")).toBeNull();
    expect(container.textContent).toContain("Use a PAT instead");

    githubIdentity.showPatFallback();
    await settleGitHubIdentity(container);
    expect(container.querySelector(".settings-secret input")).not.toBeNull();
    expect(container.textContent).not.toContain("Continue with GitHub");

    view.update({
      renderSettings: renderIdentitySettings(
        githubIdentityViewFixture({ ...githubIdentity.read(), busy: true }),
      ),
    });
    await settleGitHubIdentity(container);
    expect(button(container, "Cancel").disabled).toBe(true);
  });
});
