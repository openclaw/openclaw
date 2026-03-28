import { describeSessionBindingContractCoverage } from "../../../test/helpers/channels/session-binding-contract.js";
import { matrixSessionBindingAdapterChannels } from "../api.js";

describeSessionBindingContractCoverage(matrixSessionBindingAdapterChannels);
