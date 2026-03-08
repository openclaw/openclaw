import type { Lark } from "@larksuiteoapi/node-sdk";

declare module "@larksuiteoapi/node-sdk" {
  namespace Lark {
    interface HttpRequestOptions<D = Lark.HttpRequestBody> {
      timeout?: number;
    }
  }
}
