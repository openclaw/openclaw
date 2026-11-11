import { describe, expect, it } from "vitest";
import { parseMcpDockerCommand } from "./mcp-docker-command.js";

describe("Docker MCP launch argument boundary", () => {
  it.each([
    [
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--env",
        "TOKEN=--cidfile",
        "example/server",
        "--cidfile",
        "server-option",
      ],
    ],
    [
      "/usr/local/bin/docker",
      [
        "container",
        "run",
        "--name=operator-name",
        "--label",
        "team=tools",
        "--mount",
        "type=bind,src=/data,dst=/data",
        "example/server",
      ],
    ],
    [
      "sh",
      [
        "-c",
        "exec docker run --rm -i --env 'TOKEN=literal $value' example/server --title \"two words\"",
      ],
    ],
    ["sh", ["-c", "exec /usr/bin/docker run --rm -- example/server"]],
  ])(
    "recognizes literal launches without treating container arguments as Docker flags: %s %j",
    (command, args) => {
      expect(parseMcpDockerCommand(command, args).kind).toBe("docker");
    },
  );

  it("preserves decoded literal argument bytes and an operator-supplied name", () => {
    expect(
      parseMcpDockerCommand("sh", [
        "-c",
        "exec docker run --name custom --env 'TOKEN=literal $value' image '\"quoted\"'",
      ]),
    ).toEqual({
      kind: "docker",
      command: "docker",
      hasName: true,
      args: ["run", "--name", "custom", "--env", "TOKEN=literal $value", "image", '"quoted"'],
    });
  });

  it.each([
    ["docker", ["run", "--cidfile", "/tmp/user.cid", "image"]],
    ["docker", ["run", "--label", "openclaw.mcp.state=other", "image"]],
    ["docker", ["run", "-l=openclaw.mcp.launch=other", "image"]],
    ["docker", ["run", "--label-file", "labels.txt", "image"]],
    ["docker", ["run", "--detach", "image"]],
    ["docker", ["--context", "other", "run", "image"]],
    ["docker", ["run", "--unknown", "maybe-an-image", "image"]],
    ["docker", ["run", "--env"]],
    ["docker", ["run", "--"]],
    ["sh", ["-c", "exec docker run image; echo done"]],
    ["sh", ["-c", "exec docker run image | cat"]],
    ["sh", ["-c", "exec docker run --env TOKEN=$TOKEN image"]],
    ["sh", ["-c", 'exec docker run --env "TOKEN=$(command)" image']],
    ["sh", ["-c", "exec docker run image >output"]],
    ["sh", ["-c", "exec docker run image\ntrue"]],
    ["sh", ["-c", "exec docker run image", "extra-shell-argument"]],
    ["sh", ["-lc", "exec docker run image"]],
    ["zsh", ["-c", "exec docker run image =ls"]],
  ])(
    "refuses ambiguous vectors and custody conflicts without rewriting: %s %j",
    (command, args) => {
      expect(parseMcpDockerCommand(command, args).kind).toBe("unsafe");
    },
  );

  it.each([
    ["node", ["server.mjs"]],
    ["sh", ["-c", "exec other-server"]],
  ])("leaves other transports alone: %s %j", (command, args) => {
    expect(parseMcpDockerCommand(command, args)).toEqual({ kind: "other" });
  });
});
