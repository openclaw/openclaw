import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./src/session-contract.js";

export const whatsappDoctorSessionMigrationSurface = {
  isLegacyGroupSessionKey,
  canonicalizeLegacySessionKey,
};
