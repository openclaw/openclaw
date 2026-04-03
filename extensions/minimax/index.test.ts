import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import minimaxPlugin from "./index.js";

describe("minimax provider hooks", () => {
  it("keeps native reasoning mode for MiniMax transports", () => {
    const { providers } = registerProviderPlugin({
      plugin: minimaxPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    expect(apiProvider.hookAliases).toContain("minimax-cn");
    expect(
      apiProvider.resolveReasoningOutputMode?.({
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("native");

    expect(portalProvider.hookAliases).toContain("minimax-portal-cn");
    expect(
      portalProvider.resolveReasoningOutputMode?.({
        provider: "minimax-portal",
        modelApi: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toBe("native");
  });

  it("owns fast-mode stream wrapping for MiniMax transports", () => {
    const { providers } = registerProviderPlugin({
      plugin: minimaxPlugin,
      id: "minimax",
      name: "MiniMax Provider",
    });
    const apiProvider = requireRegisteredProvider(providers, "minimax");
    const portalProvider = requireRegisteredProvider(providers, "minimax-portal");

    let resolvedApiModelId = "";
    const captureApiModel: StreamFn = (model) => {
      resolvedApiModelId = String(model.id ?? "");
      return {} as ReturnType<StreamFn>;
    };
    const wrappedApiStream = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      extraParams: { fastMode: true },
      streamFn: captureApiModel,
    } as never);

    void wrappedApiStream?.(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    let resolvedPortalModelId = "";
    const capturePortalModel: StreamFn = (model) => {
      resolvedPortalModelId = String(model.id ?? "");
      return {} as ReturnType<StreamFn>;
    };
    const wrappedPortalStream = portalProvider.wrapStreamFn?.({
      provider: "minimax-portal",
      modelId: "MiniMax-M2.7",
      extraParams: { fastMode: true },
      streamFn: capturePortalModel,
    } as never);

    void wrappedPortalStream?.(
      {
        api: "anthropic-messages",
        provider: "minimax-portal",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(resolvedApiModelId).toBe("MiniMax-M2.7-highspeed");
    expect(resolvedPortalModelId).toBe("MiniMax-M2.7-highspeed");
  });
});
