import * as Checks from "../compiled/protocol.generated/validators-users-channel-identity.js";
import { createProtocolValidator } from "../protocol-validator.js";
import { UsersChannelIdentityParamsSchema } from "../schema/users.js";

export const validateUsersChannelIdentityParams = createProtocolValidator(
  UsersChannelIdentityParamsSchema,
  Checks.isUsersChannelIdentityParams,
);
