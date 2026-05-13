/*
 * device_identity.h
 *
 * Ed25519 device identity for the OpenClaw Linux Companion App.
 *
 * Persists a byte-compatible counterpart of the shared DeviceIdentity
 * contract used by macOS / iOS / Node / web Control UI:
 *   - 32-byte Ed25519 seed (base64-standard in "privateKey")
 *   - 32-byte raw public key (base64-standard in "publicKey")
 *   - deviceId = lowercase hex SHA-256 of the raw public key
 *   - createdAtMs = wall-clock ms at generation time
 *
 * Storage layout mirrors apps/macos DeviceIdentityStore and
 * src/infra/device-identity.ts: <state_dir>/identity/device.json, 0600.
 *
 * See apps/shared/OpenClawKit/Sources/OpenClawKit/DeviceIdentity.swift
 * for the canonical reference.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_DEVICE_IDENTITY_H
#define OPENCLAW_LINUX_DEVICE_IDENTITY_H

#include <glib.h>

typedef struct {
    gchar *device_id;        /* lowercase hex SHA-256 of raw public key */
    gchar *public_key_b64;   /* base64-standard of 32-byte raw public key */
    gchar *private_key_b64;  /* base64-standard of 32-byte Ed25519 seed */
    gint64 created_at_ms;
} OcDeviceIdentity;

/*
 * Load the persisted identity from <state_dir>/identity/device.json,
 * creating and persisting a fresh one on first run. Never returns
 * partial or invalid identities; on I/O or crypto failure returns NULL
 * and sets *out_error with a human-readable message (caller frees).
 *
 * state_dir must be non-NULL and point to the effective state directory
 * (see runtime_paths.c). Parent dirs are created with 0700 mode if absent;
 * the file is persisted with 0600 mode.
 */
OcDeviceIdentity* oc_device_identity_load_or_create(const gchar *state_dir,
                                                    GError **error);

/*
 * Sign the given payload with the identity's private seed using Ed25519.
 * Returns a newly-allocated base64url-no-padding signature string (caller
 * frees), or NULL on crypto failure.
 *
 * Matches GatewayDeviceAuthPayload.signedDeviceDictionary signature
 * encoding (base64url without padding).
 */
gchar* oc_device_identity_sign_base64url(const OcDeviceIdentity *identity,
                                         const gchar *payload);

/*
 * Return the public key in base64url-no-padding form (caller frees).
 * Used for the "publicKey" field in params.device on the connect frame.
 */
gchar* oc_device_identity_public_key_base64url(const OcDeviceIdentity *identity);

/*
 * Free all members and the struct itself.
 */
void oc_device_identity_free(OcDeviceIdentity *identity);

/*
 * Test-only seam: compute the deviceId (lowercase hex SHA-256) for the
 * given raw public key. Exposed so tests can verify the ID matches the
 * canonical contract. Returns a new g_malloc'd string (caller frees).
 */
gchar* oc_device_identity_compute_device_id(const guchar *public_key_raw,
                                            gsize public_key_len);

#endif /* OPENCLAW_LINUX_DEVICE_IDENTITY_H */
