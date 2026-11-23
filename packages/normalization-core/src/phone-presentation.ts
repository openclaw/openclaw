import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import metadata from "libphonenumber-js/min/metadata";

const sharedCountryCallingCodes = new Set(
  Object.entries(metadata.country_calling_codes)
    .filter(([, countries]) => countries.length > 1)
    .map(([callingCode]) => callingCode),
);

function parseInternationalPhoneNumber(raw: string) {
  const candidate = raw.trim();
  if (!candidate.startsWith("+")) {
    return undefined;
  }
  const phoneNumber = parsePhoneNumberFromString(candidate, { extract: false });
  return phoneNumber?.isPossible() ? phoneNumber : undefined;
}

/** Groups a possible E.164 number for reading inside a sentence, without a country name. */
export function formatInternationalPhoneNumber(raw: string): string | undefined {
  try {
    return parseInternationalPhoneNumber(raw)?.formatInternational();
  } catch {
    return undefined;
  }
}

export function formatInternationalPhoneNumberForDisplay(
  raw: string,
  locale?: string,
): string | undefined {
  try {
    const phoneNumber = parseInternationalPhoneNumber(raw);
    if (!phoneNumber) {
      return undefined;
    }

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
