import { detectParallelsHostIp } from "./host-server.ts";
import { listVmNames } from "./parallels-vm.ts";
import { parseProvider, resolveProviderAuth } from "./provider-auth.ts";

if (listVmNames().length === 0) {
  throw new Error("no Parallels guests are registered");
}
if (!detectParallelsHostIp()) {
  throw new Error("failed to detect Parallels host IP");
}
resolveProviderAuth({ provider: parseProvider(process.argv[2] ?? "") });
