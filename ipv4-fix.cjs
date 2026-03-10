// Force IPv4-first to fix Telegram connectivity on this network
// Node 22's autoSelectFamily tries IPv6 first, which times out
require("net").setDefaultAutoSelectFamily(false);
require("dns").setDefaultResultOrder("ipv4first");
