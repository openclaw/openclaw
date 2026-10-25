import assert from "node:assert/strict";
import {
  CipherContext,
  DtlsClient,
  DtlsServer,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "werift";

// Deliver datagrams asynchronously, without opening sockets or gathering ICE.
function createTransport() {
  return {
    type: "udp",
    address: { address: "127.0.0.1", family: "IPv4", port: 0 },
    closed: false,
    onData() {},
    async send() {},
    async close() {
      this.closed = true;
    },
  };
}
const clientTransport = createTransport();
const serverTransport = createTransport();
clientTransport.send = async (data) => {
  const datagram = Buffer.from(data);
  queueMicrotask(() => serverTransport.onData(datagram, ["127.0.0.1", 1]));
};
serverTransport.send = async (data) => {
  const datagram = Buffer.from(data);
  queueMicrotask(() => clientTransport.onData(datagram, ["127.0.0.1", 2]));
};
const certificate = await CipherContext.createSelfSignedCertificateWithKey(
  { hash: HashAlgorithm.sha256_4, signature: SignatureAlgorithm.ecdsa_3 },
  NamedCurveAlgorithm.secp256r1_23,
);
const options = {
  cert: certificate.certPem,
  key: certificate.keyPem,
  signatureHash: certificate.signatureHash,
};
const server = new DtlsServer({ ...options, transport: serverTransport });
const client = new DtlsClient({ ...options, transport: clientTransport });
try {
  server.onError.subscribe((error) => {
    throw error;
  });
  client.onError.subscribe((error) => {
    throw error;
  });
  const connected = Promise.all([
    client.onConnect.asPromise(5_000),
    server.onConnect.asPromise(5_000),
  ]);
  await client.connect();
  await connected;
  const received = server.onData.asPromise(5_000);
  await client.send(Buffer.from("openclaw-codecs"));
  assert.equal((await received)[0].toString(), "openclaw-codecs");
  console.log("DTLS handshake and encrypted application data passed");
} finally {
  client.close();
  server.close();
}
