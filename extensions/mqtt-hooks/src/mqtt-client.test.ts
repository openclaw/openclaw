import { describe, expect, it } from "vitest";
import { subscribeTopic, type MqttClientLike } from "./mqtt-client.js";

function createClient(subscribe: MqttClientLike["subscribe"]): MqttClientLike {
  return { subscribe } as unknown as MqttClientLike;
}

describe("subscribeTopic", () => {
  it("resolves when broker grants the subscription", async () => {
    let request: { topic: string; qos: number } | null = null;
    const client = createClient((topic, options, callback) => {
      request = { topic, qos: options.qos };
      callback(null, [{ topic, qos: options.qos }]);
    });

    await expect(subscribeTopic(client, "home/alerts/#", 1)).resolves.toBeUndefined();
    expect(request).toEqual({ topic: "home/alerts/#", qos: 1 });
  });

  it("rejects when mqtt subscribe returns an error", async () => {
    const client = createClient((_topic, _options, callback) => {
      callback(new Error("network down"));
    });

    await expect(subscribeTopic(client, "home/alerts/#", 1)).rejects.toThrow("network down");
  });

  it("rejects when broker returns SUBACK qos 128", async () => {
    const client = createClient((_topic, _options, callback) => {
      callback(null, [{ topic: "home/alerts/#", qos: 128 }]);
    });

    await expect(subscribeTopic(client, "home/alerts/#", 1)).rejects.toThrow(
      'mqtt broker rejected subscription for topic "home/alerts/#"',
    );
  });
});
