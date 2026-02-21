import { createFeishuClient } from "../client.js";
import {
  errorResult,
  json,
  runFeishuApiCall,
  type FeishuApiResponse,
} from "../tools-common/feishu-api.js";

export type TaskClient = ReturnType<typeof createFeishuClient>;

export { json, errorResult };

export async function runTaskApiCall<T extends FeishuApiResponse>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runFeishuApiCall(context, fn);
}
