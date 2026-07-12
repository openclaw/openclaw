// Whatsapp test helpers build representative Baileys phone-code credential stages.
type PhoneCodeIdentity = {
  id?: string;
  lid?: string;
};

type PhoneCodeCredsOptions = {
  registered?: boolean;
  me?: PhoneCodeIdentity;
};

const PHONE_NUMBER = "15551234567";

export function createPartialPhoneCodeCreds(options: PhoneCodeCredsOptions = {}) {
  return {
    registered: options.registered ?? false,
    pairingCode: "12345678",
    me: options.me ?? { id: `${PHONE_NUMBER}@s.whatsapp.net` },
  };
}

export function createCompletedPhoneCodeCreds(options: PhoneCodeCredsOptions = {}) {
  return {
    ...createPartialPhoneCodeCreds(options),
    account: {},
    signalIdentities: [{ identifier: { name: PHONE_NUMBER, deviceId: 0 } }],
  };
}
