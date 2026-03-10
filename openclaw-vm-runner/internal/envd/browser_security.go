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

// blockedIPRanges lists IP ranges that must be blocked for SSRF prevention.
var blockedIPRanges = []net.IPNet{
	// Link-local (cloud metadata endpoints like 169.254.169.254)
	parseCIDR("169.254.0.0/16"),
	// Loopback
	parseCIDR("127.0.0.0/8"),
	// Private RFC 1918
	parseCIDR("10.0.0.0/8"),
	parseCIDR("172.16.0.0/12"),
	parseCIDR("192.168.0.0/16"),
	// IPv6 link-local
	parseCIDR("fe80::/10"),
	// IPv6 loopback
	parseCIDR("::1/128"),
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

	// Check hardcoded hostname blocklist.
	lower := strings.ToLower(hostname)
	if lower == "localhost" {
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

// isBlockedIP checks an IP against all blocked ranges.
func isBlockedIP(ip net.IP) bool {
	for _, cidr := range blockedIPRanges {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}
