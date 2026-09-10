/** Provider-policy API for Kilo Gateway. Core reads this without loading the provider runtime. */

/** Kilo Gateway meters and rate-limits upstream; OpenClaw skips its auth-profile cooldowns. */
export const managesOwnAvailability = true;
