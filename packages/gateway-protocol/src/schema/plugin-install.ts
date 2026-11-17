/** Source intent and capability acknowledgement for plugin installation. */
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const PluginCapabilityAcknowledgmentSchema = closedObject({
  reviewToken: NonEmptyString,
});

const PluginInstallOptions = {
  /** False preserves existing enablement policy while installing the source. */
  enable: Type.Optional(Type.Boolean()),
  mode: Type.Optional(stringLiteralUnion(["install", "update"])),
  acknowledgeInstallPolicyWarning: Type.Optional(Type.Literal(true)),
  acknowledgeCapabilities: Type.Optional(PluginCapabilityAcknowledgmentSchema),
};

/** Source intent only; install provenance and capability review remain host-owned. */
export const PluginsInstallParamsSchema = Type.Union([
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("clawhub"),
    packageName: NonEmptyString,
    version: Type.Optional(NonEmptyString),
    expectedPluginId: Type.Optional(NonEmptyString),
    expectedIntegrity: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("official"),
    pluginId: NonEmptyString,
    version: Type.Optional(Type.Literal("latest")),
    pin: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("npm"),
    spec: NonEmptyString,
    pin: Type.Optional(Type.Boolean()),
    expectedPluginId: Type.Optional(NonEmptyString),
    expectedIntegrity: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("git"),
    spec: NonEmptyString,
    directory: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("local"),
    path: NonEmptyString,
    link: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("npm-pack"),
    archivePath: NonEmptyString,
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("marketplace"),
    marketplace: NonEmptyString,
    plugin: NonEmptyString,
  }),
  closedObject({
    ...PluginInstallOptions,
    source: Type.Literal("bundled"),
    pluginId: NonEmptyString,
    spec: Type.Optional(NonEmptyString),
  }),
]);

export type PluginsInstallParams = Static<typeof PluginsInstallParamsSchema>;
