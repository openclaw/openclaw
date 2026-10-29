import { expect, it, vi } from "vitest";

const cleanupMocks = vi.hoisted(() => ({
  ensureBrowserProxyUploadCleanup: vi.fn(async () => undefined),
  hasBrowserProxyUploadWork: vi.fn(() => false),
}));

vi.mock("./register.runtime.js", () => {
  throw new Error("node-host availability must not load the broad browser runtime");
});

vi.mock("./src/browser-proxy-upload-cleanup.runtime.js", () => ({
  ensureBrowserProxyUploadCleanup: cleanupMocks.ensureBrowserProxyUploadCleanup,
  hasBrowserProxyUploadWork: cleanupMocks.hasBrowserProxyUploadWork,
}));

const { browserPluginNodeHostCommands } = await import("./plugin-registration.js");

it("starts node-host upload cleanup without loading the broad browser runtime", async () => {
  const uploadCommand = browserPluginNodeHostCommands.find(
    (command) => command.command === "browser.proxy.upload.v1",
  );

  expect(uploadCommand?.hasActiveWork?.()).toBe(false);
  uploadCommand?.watchAvailability?.({ config: {}, env: {} }, vi.fn());
  expect(uploadCommand?.hasActiveWork?.()).toBe(true);

  await vi.waitFor(() => {
    expect(cleanupMocks.ensureBrowserProxyUploadCleanup).toHaveBeenCalledOnce();
  });
  expect(uploadCommand?.hasActiveWork?.()).toBe(false);
});
