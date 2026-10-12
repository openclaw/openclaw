import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { z } from "zod";
import type {
  matrixRoomSchema,
  matrixStreamingSchema,
  MatrixConfigSchema,
} from "./config-schema.js";

type MatrixConfigSchemaValue = z.infer<typeof MatrixConfigSchema>;

export type ReplyToMode = NonNullable<MatrixConfigSchemaValue["replyToMode"]>;
export type MatrixRoomConfig = NonNullable<z.infer<typeof matrixRoomSchema>>;
export type MatrixStreamingConfig = z.infer<typeof matrixStreamingSchema>;
export type MatrixStreamingMode = NonNullable<MatrixStreamingConfig["mode"]>;
type MatrixDmConfig = NonNullable<MatrixConfigSchemaValue["dm"]> & {
  sessionScope?: "per-user" | "per-room";
  threadReplies?: "off" | "inbound" | "always";
};

export type MatrixAccountConfig = Omit<
  MatrixConfigSchemaValue,
  "accounts" | "dm" | "groups" | "rooms"
> & {
  dm?: MatrixDmConfig;
  groups?: Record<string, MatrixRoomConfig>;
  rooms?: Record<string, MatrixRoomConfig>;
};
export type MatrixConfig = MatrixAccountConfig & {
  accounts?: Record<string, MatrixAccountConfig>;
};

export type CoreConfig = Pick<OpenClawConfig, "commands" | "messages" | "tools" | "secrets"> & {
  channels?: {
    matrix?: MatrixConfig;
    defaults?: Pick<
      NonNullable<NonNullable<OpenClawConfig["channels"]>["defaults"]>,
      "groupPolicy" | "contextVisibility" | "botLoopProtection"
    >;
  };
  session?: Pick<NonNullable<OpenClawConfig["session"]>, "store" | "dmScope">;
  [key: string]: unknown;
};
