// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { Status } from "nice-grpc";
// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { ClientError } from "nice-grpc";
import { describe, it, expect } from "vitest";
import { SandboxProviderError, mapGrpcError } from "./errors.js";

describe("SandboxProviderError", () => {
  it("has operation, grpcCode, and isRetryable properties", () => {
    const err = new SandboxProviderError("test message", {
      operation: "createVM",
      grpcCode: Status.INTERNAL,
      isRetryable: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SandboxProviderError);
    expect(err.message).toBe("test message");
    expect(err.operation).toBe("createVM");
    expect(err.grpcCode).toBe(Status.INTERNAL);
    expect(err.isRetryable).toBe(false);
  });
});

describe("mapGrpcError", () => {
  function makeClientError(code: Status, message: string): ClientError {
    return new ClientError("test.Service", code, message);
  }

  it("maps NOT_FOUND to non-retryable error with 'VM not found'", () => {
    const err = mapGrpcError(makeClientError(Status.NOT_FOUND, "not found"), "vmStatus");
    expect(err).toBeInstanceOf(SandboxProviderError);
    expect(err.isRetryable).toBe(false);
    expect(err.message).toContain("VM not found");
    expect(err.grpcCode).toBe(Status.NOT_FOUND);
    expect(err.operation).toBe("vmStatus");
  });

  it("maps UNAVAILABLE to retryable error with 'vm-runner unavailable'", () => {
    const err = mapGrpcError(makeClientError(Status.UNAVAILABLE, "unavailable"), "createVM");
    expect(err).toBeInstanceOf(SandboxProviderError);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toContain("vm-runner unavailable");
    expect(err.grpcCode).toBe(Status.UNAVAILABLE);
  });

  it("maps DEADLINE_EXCEEDED to retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.DEADLINE_EXCEEDED, "timeout"), "exec");
    expect(err.isRetryable).toBe(true);
    expect(err.grpcCode).toBe(Status.DEADLINE_EXCEEDED);
  });

  it("maps ALREADY_EXISTS to non-retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.ALREADY_EXISTS, "exists"), "createVM");
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.ALREADY_EXISTS);
  });

  it("maps RESOURCE_EXHAUSTED to non-retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.RESOURCE_EXHAUSTED, "exhausted"), "createVM");
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.RESOURCE_EXHAUSTED);
  });

  it("maps INTERNAL to non-retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.INTERNAL, "internal"), "exec");
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.INTERNAL);
  });

  it("maps PERMISSION_DENIED to non-retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.PERMISSION_DENIED, "denied"), "exec");
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.PERMISSION_DENIED);
  });

  it("maps INVALID_ARGUMENT to non-retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.INVALID_ARGUMENT, "invalid"), "createVM");
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.INVALID_ARGUMENT);
  });

  it("maps FAILED_PRECONDITION to non-retryable error", () => {
    const err = mapGrpcError(
      makeClientError(Status.FAILED_PRECONDITION, "precondition"),
      "destroyVM",
    );
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.FAILED_PRECONDITION);
  });

  it("maps UNIMPLEMENTED to non-retryable error", () => {
    const err = mapGrpcError(makeClientError(Status.UNIMPLEMENTED, "unimplemented"), "exec");
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBe(Status.UNIMPLEMENTED);
  });

  it("wraps unknown error with isRetryable=false", () => {
    const err = mapGrpcError(new Error("something went wrong"), "createVM");
    expect(err).toBeInstanceOf(SandboxProviderError);
    expect(err.isRetryable).toBe(false);
    expect(err.grpcCode).toBeUndefined();
    expect(err.operation).toBe("createVM");
  });

  it("preserves existing SandboxProviderError (pass-through)", () => {
    const original = new SandboxProviderError("already wrapped", {
      operation: "exec",
      isRetryable: true,
    });
    const result = mapGrpcError(original, "createVM");
    expect(result).toBe(original);
    expect(result.operation).toBe("exec"); // preserves original operation
  });
});
