import { type SignedAnnouncement, verifyAnnouncement } from "@lobstah/protocol";
import { addPeer, loadPeers, removePeer } from "@lobstah/router";

export const peers = async (args: string[]): Promise<void> => {
  const sub = args[0];
  switch (sub) {
    case "add": {
      const pubkey = args[1];
      const url = args[2];
      const label = args[3];
      if (!pubkey || !url) {
        process.stderr.write("usage: lobstah peers add <pubkey> <url> [label]\n");
        process.exit(2);
      }
      const list = await addPeer({ pubkey, url, label });
      process.stdout.write(`added peer ${pubkey} -> ${url}\n`);
      process.stdout.write(`(${list.length} peer${list.length === 1 ? "" : "s"} total)\n`);
      return;
    }
    case "remove": {
      const pubkey = args[1];
      if (!pubkey) {
        process.stderr.write("usage: lobstah peers remove <pubkey>\n");
        process.exit(2);
      }
      const list = await removePeer(pubkey);
      process.stdout.write(`removed peer ${pubkey}\n`);
      process.stdout.write(`(${list.length} peer${list.length === 1 ? "" : "s"} remaining)\n`);
      return;
    }
    case "sync": {
      const trackerUrl = args[1];
      if (!trackerUrl) {
        process.stderr.write("usage: lobstah peers sync <tracker-url>\n");
        process.exit(2);
      }
      let res: Response;
      try {
        res = await fetch(`${trackerUrl.replace(/\/$/, "")}/peers`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`could not reach tracker at ${trackerUrl}: ${msg}\n`);
        process.exit(1);
      }
      if (!res.ok) {
        process.stderr.write(`tracker ${res.status}: ${await res.text()}\n`);
        process.exit(1);
      }
      const data = (await res.json()) as { peers?: SignedAnnouncement[] };
      const incoming = data.peers ?? [];
      let added = 0;
      let rejected = 0;
      for (const signed of incoming) {
        if (!verifyAnnouncement(signed)) {
          rejected += 1;
          continue;
        }
        const a = signed.announcement;
        await addPeer({ pubkey: a.pubkey, url: a.url, label: a.label });
        added += 1;
      }
      process.stdout.write(
        `synced ${added} peer(s) from ${trackerUrl}` +
          (rejected ? ` (rejected ${rejected} with bad signatures)` : "") +
          "\n",
      );
      return;
    }
    case "list":
    case undefined: {
      const list = await loadPeers();
      if (list.length === 0) {
        process.stdout.write("no peers configured\n");
        return;
      }
      for (const p of list) {
        const lbl = p.label ? `  [${p.label}]` : "";
        process.stdout.write(`  ${p.pubkey}\n    ${p.url}${lbl}\n`);
      }
      return;
    }
    default:
      process.stderr.write(`unknown peers subcommand: ${sub}\n`);
      process.exit(2);
  }
};
