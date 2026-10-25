import { it } from "vitest";
import { CanvasDocumentViewResultSchema } from "./canvas.js";
import { accepts, rejects } from "./schema.test-support.js";

const document = {
  html: "<p>Widget</p>",
  sandboxUrl: "/mcp-app-sandbox?csp=encoded",
  sandboxPort: 18790,
};

it("accepts each embed ceiling and older Canvas responses without a policy field", () => {
  accepts(CanvasDocumentViewResultSchema, document);
  for (const embedSandbox of ["strict", "scripts", "trusted"] as const) {
    accepts(CanvasDocumentViewResultSchema, { ...document, embedSandbox });
  }
});

it("rejects unsupported policy values and extra Canvas response fields", () => {
  for (const embedSandbox of ["unknown", "", null, true, {}]) {
    rejects(CanvasDocumentViewResultSchema, { ...document, embedSandbox });
  }
  rejects(CanvasDocumentViewResultSchema, { ...document, allowScripts: true });
});
