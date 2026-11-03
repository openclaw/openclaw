import type { Static } from "typebox";
import type * as Schema from "./plugins.js";

export type PluginCatalogEntry = Static<typeof Schema.PluginCatalogEntrySchema>;
export type ControlUiPluginTab = Static<typeof Schema.ControlUiPluginTabSchema>;
export type ControlUiPluginWidgetKind = Static<typeof Schema.ControlUiPluginWidgetKindSchema>;
export type PluginRuntimeStatus = Static<typeof Schema.PluginRuntimeStatusSchema>;
export type PluginsListParams = Static<typeof Schema.PluginsListParamsSchema>;
export type PluginsListResult = Static<typeof Schema.PluginsListResultSchema>;
export type PluginsInspectParams = Static<typeof Schema.PluginsInspectParamsSchema>;
export type PluginsInspectResult = Static<typeof Schema.PluginsInspectResultSchema>;
export type PluginsSearchParams = Static<typeof Schema.PluginsSearchParamsSchema>;
export type PluginsSearchResult = Static<typeof Schema.PluginsSearchResultSchema>;
export type PluginDiscoveryCategory = Static<typeof Schema.PluginDiscoveryCategorySchema>;
export type PluginDiscoveryCatalogFacts = Static<typeof Schema.PluginDiscoveryCatalogFactsSchema>;
export type PluginDiscoveryLocalFacts = Static<typeof Schema.PluginDiscoveryLocalFactsSchema>;
export type PluginDiscoveryEntry = Static<typeof Schema.PluginDiscoveryEntrySchema>;
export type PluginDiscoveryDetail = Static<typeof Schema.PluginDiscoveryDetailSchema>;
export type PluginsCatalogBrowseParams = Static<typeof Schema.PluginsCatalogBrowseParamsSchema>;
export type PluginsCatalogBrowseResult = Static<typeof Schema.PluginsCatalogBrowseResultSchema>;
export type PluginsCatalogCategoriesParams = Static<
  typeof Schema.PluginsCatalogCategoriesParamsSchema
>;
export type PluginsCatalogCategoriesResult = Static<
  typeof Schema.PluginsCatalogCategoriesResultSchema
>;
export type PluginsCatalogGetParams = Static<typeof Schema.PluginsCatalogGetParamsSchema>;
export type PluginsCatalogGetResult = Static<typeof Schema.PluginsCatalogGetResultSchema>;
export type PluginsInstallParams = Static<typeof Schema.PluginsInstallParamsSchema>;
export type PluginsInstallResult = Static<typeof Schema.PluginsInstallResultSchema>;
export type PluginsRefreshParams = Static<typeof Schema.PluginsRefreshParamsSchema>;
export type PluginsRefreshResult = Static<typeof Schema.PluginsRefreshResultSchema>;
export type PluginReloadTarget = Static<typeof Schema.PluginReloadTargetSchema>;
export type PluginsReloadParams = Static<typeof Schema.PluginsReloadParamsSchema>;
export type PluginsReloadResult = Static<typeof Schema.PluginsReloadResultSchema>;
export type PluginRuntimeApplication = Static<typeof Schema.PluginRuntimeApplicationSchema>;
export type PluginsChangedEvent = Static<typeof Schema.PluginsChangedEventSchema>;
export type PluginsUninstallParams = Static<typeof Schema.PluginsUninstallParamsSchema>;
export type PluginsUninstallResult = Static<typeof Schema.PluginsUninstallResultSchema>;
export type PluginsSetEnabledParams = Static<typeof Schema.PluginsSetEnabledParamsSchema>;
export type PluginsSetEnabledResult = Static<typeof Schema.PluginsSetEnabledResultSchema>;
export type PluginControlUiDescriptor = Static<typeof Schema.PluginControlUiDescriptorSchema>;
export type PluginsUiDescriptorsParams = Static<typeof Schema.PluginsUiDescriptorsParamsSchema>;
export type PluginsUiDescriptorsResult = Static<typeof Schema.PluginsUiDescriptorsResultSchema>;
export type PluginControlUiModule = Static<typeof Schema.PluginControlUiModuleSchema>;
export type PluginControlUiDiagnostic = Static<typeof Schema.PluginControlUiDiagnosticSchema>;
export type PluginsControlUiCatalog = Static<typeof Schema.PluginsControlUiCatalogSchema>;
export type PluginsControlUiReloadParams = Static<typeof Schema.PluginsControlUiReloadParamsSchema>;
export type PluginsSessionActionParams = Static<typeof Schema.PluginsSessionActionParamsSchema>;
export type PluginsSessionActionResult = Static<typeof Schema.PluginsSessionActionResultSchema>;
