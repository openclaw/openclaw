import { describe } from "vitest";
import { installDmPolicyContractSuite } from "../../../test/helpers/channels/dm-policy-contract.js";

describe("bluebubbles dm policy contract", () => {
	installDmPolicyContractSuite("bluebubbles");
});
