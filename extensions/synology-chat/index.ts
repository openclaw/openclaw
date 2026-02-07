import { synologyChatPlugin } from "./src/channel.js";
import { setSynologyChatRuntime } from "./src/runtime.js";

export default function register(api: unknown) {
  if (api && typeof api === "object" && "runtime" in api && "registerChannel" in api) {
    const typedApi = api as {
      runtime: unknown;
      registerChannel: (config: { plugin: typeof synologyChatPlugin }) => void;
    };
    setSynologyChatRuntime(typedApi.runtime);
    typedApi.registerChannel({ plugin: synologyChatPlugin });
  } else {
    throw new Error("Invalid API object provided to Synology Chat plugin");
  }
}
