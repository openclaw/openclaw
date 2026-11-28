import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import metadata from "libphonenumber-js/min/metadata";

const sharedCountryCallingCodes = new Set(
  Object.entries(metadata.country_calling_codes)
    .filter(([, countries]) => countries.length > 1)
    .map(([callingCode]) => callingCode),
);

function parsePossibleInternationalNumber(raw: string) {
  const candidate = raw.trim();
  if (!candidate.startsWith("+")) {
    return undefined;
  }
  try {
    const phoneNumber = parsePhoneNumberFromString(candidate, { extract: false });
    return phoneNumber?.isPossible() ? phoneNumber : undefined;
  } catch {
    return undefined;
  }
}

/** Compact international form for identity labels, where the calling code already names the region. */
export function formatInternationalPhoneNumber(raw: string): string | undefined {
  return parsePossibleInternationalNumber(raw)?.formatInternational();
}

export function formatInternationalPhoneNumberForDisplay(
  raw: string,
  locale?: string,
): string | undefined {
  const phoneNumber = parsePossibleInternationalNumber(raw);
  if (!phoneNumber) {
    return undefined;
  }

  try {
    const international = phoneNumber.formatInternational();
    if (!phoneNumber.country || sharedCountryCallingCodes.has(phoneNumber.countryCallingCode)) {
      return international;
    }

    const countryName = new Intl.DisplayNames(locale ? [locale] : undefined, {
      type: "region",
    }).of(phoneNumber.country);
    return `${countryName || phoneNumber.country} · ${international}`;
  } catch {
    return undefined;
  }
}
