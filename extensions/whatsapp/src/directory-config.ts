import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import {
	type DirectoryConfigParams,
	listResolvedDirectoryGroupEntriesFromMapKeys,
	listResolvedDirectoryUserEntriesFromAllowFrom,
} from "openclaw/plugin-sdk/directory-runtime";
import {
	type ResolvedWhatsAppAccount,
	resolveWhatsAppAccount,
} from "./accounts.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

export async function listWhatsAppDirectoryPeersFromConfig(
	params: DirectoryConfigParams,
) {
	return listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedWhatsAppAccount>(
		{
			...params,
			resolveAccount: adaptScopedAccountAccessor(resolveWhatsAppAccount),
			resolveAllowFrom: (account) => account.allowFrom,
			normalizeId: (entry) => {
				const normalized = normalizeWhatsAppTarget(entry);
				if (!normalized || isWhatsAppGroupJid(normalized)) {
					return null;
				}
				return normalized;
			},
		},
	);
}

export async function listWhatsAppDirectoryGroupsFromConfig(
	params: DirectoryConfigParams,
) {
	return listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedWhatsAppAccount>({
		...params,
		resolveAccount: adaptScopedAccountAccessor(resolveWhatsAppAccount),
		resolveGroups: (account) => account.groups,
	});
}
