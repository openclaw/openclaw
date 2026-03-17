import { EventEmitter } from "node:events";
function makeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1" };
  req.destroyed = false;
  req.destroy = ((_) => {
    if (req.destroyed) {
      return req;
    }
    req.destroyed = true;
    return req;
  });
  process.nextTick(() => {
    if (req.destroyed) {
      return;
    }
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}
function makeRes() {
  const res = {
    _status: 0,
    _body: "",
    writeHead(statusCode, _headers) {
      res._status = statusCode;
    },
    end(body) {
      res._body = body ?? "";
    }
  };
  return res;
}
function makeFormBody(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
export {
  makeFormBody,
  makeReq,
  makeRes
};
