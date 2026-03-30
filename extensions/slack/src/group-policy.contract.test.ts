import { describe } from "vitest";
import { installSlackGroupPolicyContractSuite } from "../../../test/helpers/channels/group-policy-contract.js";

describe("slack group policy contract", () => {
	installSlackGroupPolicyContractSuite();
});
