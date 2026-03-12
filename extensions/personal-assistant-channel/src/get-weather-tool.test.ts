import { describe, expect, it, vi } from "vitest";
import { getWeatherTool } from "./get-weather-tool.js";

describe("get_weather tool", () => {
  const sessionKey = "agent:user-1:web:direct:session-1";

  it("returns weather summary when the assistant API succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        summary: "明天上海晴间多云，16.1°C 到 24.3°C，降水概率 5%。",
        location: { name: "上海" },
        forecast: { day: "tomorrow", weather_text: "晴间多云" },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    const tool = getWeatherTool(
      {
        pluginConfig: {
          assistantApiBaseUrl: "http://127.0.0.1:4000",
          assistantApiToken: "internal-token",
        },
        registerTool() {},
      } as never,
      { sessionKey },
    );

    const result = await tool.execute("tool-1", { day: "tomorrow", location: "上海" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.content).toEqual([
      { type: "text", text: "明天上海晴间多云，16.1°C 到 24.3°C，降水概率 5%。" },
    ]);
  });

  it("returns a follow-up instruction when location is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: "location_unavailable",
          reason: "permission_denied",
        }),
      }),
    );

    const tool = getWeatherTool(
      {
        pluginConfig: {
          assistantApiBaseUrl: "http://127.0.0.1:4000",
          assistantApiToken: "internal-token",
        },
        registerTool() {},
      } as never,
      { sessionKey },
    );

    const result = await tool.execute("tool-1", { day: "today" });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "当前没有可用位置信息。请让用户授权当前位置，或直接告诉你想查哪个城市。",
      },
    ]);
    expect(result.details).toEqual({
      needsUserLocation: true,
      reason: "permission_denied",
    });
  });
});
