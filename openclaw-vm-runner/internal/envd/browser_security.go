package envd

import (
	"context"
	"encoding/binary"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// blockedProtocols lists URL schemes that must never be navigated to.
var blockedProtocols = map[string]bool{
	"file":             true,
	"chrome":           true,
	"chrome-extension": true,
	"data":             true,
	"javascript":       true,
	"vbscript":         true,
}

// blockedCIDRs lists additional IP ranges not covered by Go's net.IP helpers.
// The primary blocking is done via isBlockedIP using Go stdlib classification.
var blockedCIDRs = []net.IPNet{
	// IETF "shared address space" for CGN (RFC 6598) — not covered by IsPrivate().
	parseCIDR("100.64.0.0/10"),
}

// blockedHostnames lists cloud metadata hostnames and IPs that must be blocked.
var blockedHostnames = map[string]bool{
	"localhost":                true,
	"metadata.google.internal": true,
	// Alibaba Cloud metadata endpoint
	"100.100.100.200": true,
	// AWS IPv6 metadata endpoint (also covered by fc00::/7 CIDR above)
	"fd00:ec2::254": true,
}

// URLPolicy validates URLs before browser navigation to prevent SSRF attacks.
type URLPolicy struct {
	BlockedDomains []string // optional additional domain blocklist
}

// DefaultURLPolicy returns a URLPolicy with default settings.
func DefaultURLPolicy() *URLPolicy {
	return &URLPolicy{}
}

// Validate checks a raw URL against protocol, IP, and domain blocklists.
// It resolves hostnames via DNS and blocks any that resolve to private/internal IPs.
// Returns nil for safe URLs, an error describing the block reason otherwise.
func (p *URLPolicy) Validate(ctx context.Context, rawURL string) error {
	if rawURL == "" {
		return fmt.Errorf("invalid URL: empty")
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme == "" {
		return fmt.Errorf("invalid URL: no scheme")
	}

	// Check blocked protocols.
	if blockedProtocols[scheme] {
		return fmt.Errorf("blocked protocol: %s", scheme)
	}

	// Only allow http and https.
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("unsupported protocol: %s", scheme)
	}

	hostname := parsed.Hostname()
	if hostname == "" {
		return fmt.Errorf("invalid URL: no hostname")
	}

	// Check hardcoded hostname blocklist (cloud metadata, localhost).
	lower := strings.ToLower(hostname)
	if blockedHostnames[lower] {
		return fmt.Errorf("blocked address: %s", hostname)
	}

	// Check optional additional domain blocklist.
	for _, d := range p.BlockedDomains {
		if strings.ToLower(d) == lower {
			return fmt.Errorf("blocked domain: %s", hostname)
		}
	}

	// Try parsing as a standard dotted IP.
	if ip := net.ParseIP(hostname); ip != nil {
		if isBlockedIP(ip) {
			return fmt.Errorf("blocked IP address: %s", hostname)
		}
		return nil
	}

	// Try parsing as a decimal-encoded IP (e.g. 2852039166 for 169.254.169.254).
	if ip := parseDecimalIP(hostname); ip != nil {
		if isBlockedIP(ip) {
			return fmt.Errorf("blocked IP address (decimal): %s", hostname)
		}
		return nil
	}

	// Try parsing as a hex-encoded IP (e.g. 0xA9FEA9FE for 169.254.169.254).
	if ip := parseHexIP(hostname); ip != nil {
		if isBlockedIP(ip) {
			return fmt.Errorf("blocked IP address (hex): %s", hostname)
		}
		return nil
	}

	// Hostname is not an IP literal — resolve via DNS and check all resulting IPs.
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", hostname)
	if err != nil {
		return fmt.Errorf("DNS resolution failed for %s: %w", hostname, err)
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return fmt.Errorf("blocked IP address (resolved %s -> %s)", hostname, ip.String())
		}
	}

	return nil
}

// parseCIDR is a helper for package-level init of blocked IP ranges.
func parseCIDR(cidr string) net.IPNet {
	_, ipnet, err := net.ParseCIDR(cidr)
	if err != nil {
		panic(fmt.Sprintf("invalid CIDR: %s", cidr))
	}
	return *ipnet
}

// parseDecimalIP converts a decimal-encoded IP (e.g. "2852039166") to net.IP.
// Returns nil if the host is not a valid decimal integer IP.
func parseDecimalIP(host string) net.IP {
	n := new(big.Int)
	_, ok := n.SetString(host, 10)
	if !ok {
		return nil
	}
	// Must be positive and fit in 4 bytes (IPv4).
	if n.Sign() < 0 || n.BitLen() > 32 {
		return nil
	}
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, uint32(n.Uint64()))
	return net.IP(b)
}

// parseHexIP converts a hex-encoded IP (e.g. "0xA9FEA9FE") to net.IP.
// Returns nil if the host is not a valid hex IP.
func parseHexIP(host string) net.IP {
	lower := strings.ToLower(host)
	if !strings.HasPrefix(lower, "0x") {
		return nil
	}
	hexStr := lower[2:]
	if hexStr == "" {
		return nil
	}
	val, err := strconv.ParseUint(hexStr, 16, 32)
	if err != nil {
		return nil
	}
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, uint32(val))
	return net.IP(b)
}

// isBlockedIP uses Go's standard library IP classification to block any
// non-public-unicast address. This is more robust than maintaining a manual
// CIDR list, as it covers all special-purpose ranges including:
//   - Loopback (127.0.0.0/8, ::1)
//   - Private/RFC1918 (10/8, 172.16/12, 192.168/16) + IPv6 ULA (fc00::/7)
//   - Link-local (169.254/16, fe80::/10)
//   - Multicast (224/4, ff00::/8)
//   - Unspecified (0.0.0.0, ::)
//
// Additionally checks blockedCIDRs for ranges not covered by stdlib (e.g. CGN 100.64/10).
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, cidr := range blockedCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}
