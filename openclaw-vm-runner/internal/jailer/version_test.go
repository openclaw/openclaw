package jailer

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMinFirecrackerVersion(t *testing.T) {
	assert.Equal(t, "1.14.1", MinFirecrackerVersion)
}

func TestValidateFirecrackerVersion(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
		errMsg  string
	}{
		{
			name:    "exact minimum version",
			input:   "Firecracker v1.14.1",
			wantErr: false,
		},
		{
			name:    "patch above minimum",
			input:   "Firecracker v1.14.2",
			wantErr: false,
		},
		{
			name:    "minor above minimum",
			input:   "Firecracker v1.15.0",
			wantErr: false,
		},
		{
			name:    "major above minimum",
			input:   "Firecracker v2.0.0",
			wantErr: false,
		},
		{
			name:    "patch below minimum",
			input:   "Firecracker v1.14.0",
			wantErr: true,
			errMsg:  "CVE-2026-1386",
		},
		{
			name:    "minor below minimum",
			input:   "Firecracker v1.13.1",
			wantErr: true,
			errMsg:  "CVE-2026-1386",
		},
		{
			name:    "major below minimum",
			input:   "Firecracker v0.25.0",
			wantErr: true,
			errMsg:  "CVE-2026-1386",
		},
		{
			name:    "empty version string",
			input:   "",
			wantErr: true,
		},
		{
			name:    "unparseable version",
			input:   "not-a-version",
			wantErr: true,
		},
		{
			name:    "missing v prefix",
			input:   "Firecracker 1.14.1",
			wantErr: true,
		},
		{
			name:    "lowercase firecracker prefix",
			input:   "firecracker v1.14.1",
			wantErr: false,
		},
		{
			name:    "version with extra text",
			input:   "Firecracker v1.14.1\nsome extra output",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateFirecrackerVersion(tt.input)
			if tt.wantErr {
				require.Error(t, err)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
			} else {
				require.NoError(t, err)
			}
		})
	}
}
