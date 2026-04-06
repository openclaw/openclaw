import { afterEach, describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa mock openai server", () => {
  it("serves health and streamed responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Inspect the repo docs and kickoff task." }],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.added"');
    expect(body).toContain('"name":"read"');
  });

  it("prefers path-like refs over generic quoted keys in prompts", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"arguments":"{\\"path\\":\\"QA_KICKOFF_TASK.md\\"}"');

    const debugResponse = await fetch(`${server.baseUrl}/debug/last-request`);
    expect(debugResponse.status).toBe(200);
    expect(await debugResponse.json()).toMatchObject({
      prompt: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
      allInputText: 'Please inspect "message_id" metadata first, then read `./QA_KICKOFF_TASK.md`.',
      plannedToolName: "read",
    });
  });

  it("drives the Lobster Invaders write flow and memory recall responses", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const lobster = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Please build Lobster Invaders after reading context." },
            ],
          },
          {
            type: "function_call_output",
            output: "QA mission: read source and docs first.",
          },
        ],
      }),
    });
    expect(lobster.status).toBe(200);
    const lobsterBody = await lobster.text();
    expect(lobsterBody).toContain('"name":"write"');
    expect(lobsterBody).toContain("lobster-invaders.html");

    const recall = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        model: "gpt-5.4-alt",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Please remember this fact for later: the QA canary code is ALPHA-7.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "What was the QA canary code I asked you to remember earlier?",
              },
            ],
          },
        ],
      }),
    });
    expect(recall.status).toBe(200);
    const payload = (await recall.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(payload.output?.[0]?.content?.[0]?.text).toContain("ALPHA-7");

    const requests = await fetch(`${server.baseUrl}/debug/requests`);
    expect(requests.status).toBe(200);
    expect((await requests.json()) as Array<{ model?: string }>).toMatchObject([
      { model: "gpt-5.4" },
      { model: "gpt-5.4-alt" },
    ]);
  });

  it("requests non-threaded subagent handoff for QA channel runs", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Delegate a bounded QA task to a subagent, then summarize the delegated result clearly.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"name":"sessions_spawn"');
    expect(body).toContain('\\"label\\":\\"qa-sidecar\\"');
    expect(body).toContain('\\"thread\\":false');
  });

  it("plans memory tools and serves mock image generations", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const memorySearch = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
              },
            ],
          },
        ],
      }),
    });
    expect(memorySearch.status).toBe(200);
    expect(await memorySearch.text()).toContain('"name":"memory_search"');

    const image = await fetch(`${server.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "Draw a QA lighthouse",
        n: 1,
        size: "1024x1024",
      }),
    });
    expect(image.status).toBe(200);
    expect(await image.json()).toMatchObject({
      data: [{ b64_json: expect.any(String) }],
    });
  });

  it("returns exact markers for visible and hot-installed skills", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const visible = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Visible skill marker: give me the visible skill marker exactly.",
              },
            ],
          },
        ],
      }),
    });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      output: [
        {
          content: [{ text: "VISIBLE-SKILL-OK" }],
        },
      ],
    });

    const hot = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Hot install marker: give me the hot install marker exactly.",
              },
            ],
          },
        ],
      }),
    });
    expect(hot.status).toBe(200);
    expect(await hot.json()).toMatchObject({
      output: [
        {
          content: [{ text: "HOT-INSTALL-OK" }],
        },
      ],
    });
  });

  it("ignores stale tool output from prior turns when planning the current turn", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Read QA_KICKOFF_TASK.md first." }],
          },
          {
            type: "function_call_output",
            output: "QA mission: read source and docs first.",
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"name":"read"');
  });

  it("returns NO_REPLY for unmentioned group chatter", async () => {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: 'Conversation info (untrusted metadata): {"is_group_chat": true}\n\nhello team, no bot ping here',
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [
        {
          content: [{ text: "NO_REPLY" }],
        },
      ],
    });
  });
});
