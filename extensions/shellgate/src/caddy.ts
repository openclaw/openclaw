/** Import inside an existing route, before Basic auth. Arguments: upstream, identity header. */
export const SHELLGATE_CADDY_SNIPPET = `(shellgate) {
    @shellgate_verify path /plugins/shellgate/verify*
    respond @shellgate_verify 404

    request_header -{args[1]}
    request_header -X-Forwarded-*
    request_header -Forwarded
    request_header -X-Real-IP
    request_header -X-Shellgate-*
    request_header -X-OpenClaw-Scopes
    request_header -X-Occ-*
    request_header -X-Factory-*
    request_header -Remote-User
    request_header -X-Remote-User
    request_header -X-Auth-Request-*
    request_header -Cf-Access-*
    request_header -Tailscale-*

    @shellgate_bearer header_regexp Authorization (?i)^Bearer(?:[[:space:]]|$)
    handle @shellgate_bearer {
        route {
            forward_auth {args[0]} {
                uri /plugins/shellgate/verify?
                copy_headers X-Shellgate-User>{args[1]}
                header_up X-Forwarded-For {client_ip}
                header_up -Connection
                header_up -Upgrade
            }
            @shellgate_missing not header {args[1]} *
            respond @shellgate_missing 503
            reverse_proxy {args[0]} {
                header_up -Authorization
                header_up X-Forwarded-For {client_ip}
            }
        }
    }
}
`;
