import { describe } from "vitest";
import { installDmPolicyContractSuite } from "../../../test/helpers/channels/dm-policy-contract.js";

describe("signal dm policy contract", () => {
	installDmPolicyContractSuite("signal");
});
