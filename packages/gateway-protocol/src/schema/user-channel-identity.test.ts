import { expect, it } from "vitest";
import { UserChannelIdentitySchema as PublicSchema } from "../schema.js";
import { UserChannelIdentitySchema } from "./user-channel-identity.js";
import { UserChannelIdentitySchema as UsersSchema } from "./users.js";

it("preserves one nominal channel identity schema through the public exports", () => {
  expect(PublicSchema).toBe(UserChannelIdentitySchema);
  expect(UsersSchema).toBe(UserChannelIdentitySchema);
});
