import { afterEach, beforeEach, type Mock } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";

export function useFinalizationAdmission(mocks: Mock[], purpose = "finalization-test") {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let context: AdmittedRunContext;
  beforeEach(async () => {
    for (const mock of mocks) {
      mock.mockReset();
    }
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", purpose);
    context = await admission.admit("embedded");
  });
  afterEach(() => admission.close());
  return () => context;
}
