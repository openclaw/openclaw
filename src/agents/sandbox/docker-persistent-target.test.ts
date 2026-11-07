import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execContainer: vi.fn() }));

vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  execContainer: mocks.execContainer,
}));

const { captureDockerPersistentTarget } = await import("./docker-persistent-target.js");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("prefers DOCKER_HOST when DOCKER_CONTEXT is also set", async () => {
  vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", "other");
  mocks.execContainer.mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "context") {
      return { code: 0, stdout: '{"Host":"unix:///var/run/docker.sock"}', stderr: "" };
    }
    return { code: 0, stdout: "daemon-id", stderr: "" };
  });

  await expect(captureDockerPersistentTarget()).resolves.toEqual({
    kind: "docker",
    daemonId: "daemon-id",
    endpoint: "unix:///var/run/docker.sock",
  });
  expect(mocks.execContainer).toHaveBeenCalledTimes(2);
  expect(mocks.execContainer.mock.calls[0]?.[1]).toEqual([
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker}}",
  ]);
  expect(mocks.execContainer.mock.calls[1]?.[0]).toMatchObject({
    globalArgs: ["--host", "unix:///var/run/docker.sock"],
  });
});

it("uses Docker's normalized endpoint for DOCKER_HOST", async () => {
  vi.stubEnv("DOCKER_HOST", "unix://");
  vi.stubEnv("DOCKER_CONTEXT", "other");
  mocks.execContainer
    .mockResolvedValueOnce({
      code: 0,
      stdout: '{"Host":"unix:///var/run/docker.sock"}',
      stderr: "",
    })
    .mockResolvedValueOnce({ code: 0, stdout: "daemon-id", stderr: "" });

  await expect(captureDockerPersistentTarget()).resolves.toMatchObject({
    endpoint: "unix:///var/run/docker.sock",
  });
  expect(mocks.execContainer.mock.calls[0]?.[1]).not.toContain("other");
});

it("uses DOCKER_CONTEXT when DOCKER_HOST is unset", async () => {
  vi.stubEnv("DOCKER_HOST", undefined);
  vi.stubEnv("DOCKER_CONTEXT", "other");
  mocks.execContainer
    .mockResolvedValueOnce({
      code: 0,
      stdout: '{"Host":"unix:///tmp/other.sock"}',
      stderr: "",
    })
    .mockResolvedValueOnce({ code: 0, stdout: "daemon-id", stderr: "" });

  await expect(captureDockerPersistentTarget()).resolves.toEqual({
    kind: "docker",
    daemonId: "daemon-id",
    endpoint: "unix:///tmp/other.sock",
  });
  expect(mocks.execContainer.mock.calls[0]?.[1]).toEqual([
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker}}",
  ]);
});

it("delegates whitespace-only DOCKER_HOST precedence to Docker", async () => {
  vi.stubEnv("DOCKER_HOST", "   ");
  vi.stubEnv("DOCKER_CONTEXT", "other");
  mocks.execContainer
    .mockResolvedValueOnce({
      code: 0,
      stdout: '{"Host":"unix:///var/run/docker.sock"}',
      stderr: "",
    })
    .mockResolvedValueOnce({ code: 0, stdout: "daemon-id", stderr: "" });

  await expect(captureDockerPersistentTarget()).resolves.toMatchObject({
    endpoint: "unix:///var/run/docker.sock",
  });
  expect(mocks.execContainer.mock.calls[0]?.[1]).not.toContain("other");
});

it("does not pin an unsupported DOCKER_HOST transport even when a context is set", async () => {
  vi.stubEnv("DOCKER_HOST", "tcp://docker.example:2376");
  vi.stubEnv("DOCKER_CONTEXT", "local");
  mocks.execContainer.mockResolvedValueOnce({
    code: 0,
    stdout: '{"Host":"tcp://docker.example:2376"}',
    stderr: "",
  });

  await expect(captureDockerPersistentTarget()).resolves.toBeUndefined();
  expect(mocks.execContainer).toHaveBeenCalledOnce();
  expect(mocks.execContainer.mock.calls[0]?.[1]).not.toContain("local");
});
