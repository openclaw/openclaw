import { describe, expect, it } from "vitest";
import { FeishuDriveSchema } from "./drive-schema.js";

type SchemaObjectWithProperties = {
  properties?: Record<string, { const?: string; description?: string } | undefined>;
};

describe("FeishuDriveSchema", () => {
  it("documents add_comment ambient thread compatibility", () => {
    const addCommentSchema = FeishuDriveSchema.anyOf.find(
      (item) => item?.properties?.action?.const === "add_comment",
    ) as SchemaObjectWithProperties | undefined;

    expect(addCommentSchema).toBeDefined();
    expect(addCommentSchema?.properties?.file_type?.description).toContain(
      "may be delivered as a follow-up reply",
    );
    expect(addCommentSchema?.properties?.block_id?.description).toContain(
      "outside an ambient comment-thread flow",
    );
  });
});
