import {
	describeChannelRegistryBackedContracts,
	describeSessionBindingRegistryBackedContract,
} from "../../../test/helpers/channels/registry-backed-contract.js";

describeChannelRegistryBackedContracts("telegram");
describeSessionBindingRegistryBackedContract("telegram");
