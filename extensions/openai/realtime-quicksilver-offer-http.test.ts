import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  readOfferBearerToken,
  REALTIME_OFFER_TOKEN_HEADER,
} from "./realtime-quicksilver-offer-http.js";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

const headerName = REALTIME_OFFER_TOKEN_HEADER.toLowerCase();

describe("readOfferBearerToken", () => {
  it("reads the reservation header when Authorization is proxy basic auth", () => {
    expect(
      readOfferBearerToken(
        request({
          authorization: "Basic bm90LXRoZS1yZXNlcnZhdGlvbg==",
          [headerName]: "reservation-token",
        }),
      ),
    ).toBe("reservation-token");
  });

  it("keeps Authorization bearer for clients that do not send the reservation header", () => {
    expect(
      readOfferBearerToken(
        request({
          authorization: "Bearer reservation-token",
        }),
      ),
    ).toBe("reservation-token");
  });

  it("ignores a combined reservation header and does not treat basic auth as a token", () => {
    expect(
      readOfferBearerToken(
        request({
          authorization: "Basic bm90LXRoZS1yZXNlcnZhdGlvbg==",
          [headerName]: "one, two",
        }),
      ),
    ).toBeUndefined();
    expect(
      readOfferBearerToken(
        request({
          authorization: "Bearer reservation-token",
          [headerName]: "one, two",
        }),
      ),
    ).toBe("reservation-token");
  });
});
