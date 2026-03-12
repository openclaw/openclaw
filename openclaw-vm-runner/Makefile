.PHONY: generate lint test build build-envd build-rootfs clean

# Generate Go code from proto files using buf
generate:
	buf generate

# Lint proto files using buf
lint:
	buf lint

# Run all unit tests
test:
	go test ./internal/... -v

# Build all packages
build:
	go build ./...

# Build envd binary (static, stripped) for Linux amd64
build-envd:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o envd ./cmd/envd/

# Build rootfs ext4 image (requires root/sudo for mount)
build-rootfs: build-envd
	sudo ./images/rootfs/build-rootfs.sh

# Clean build artifacts and generated files
clean:
	rm -rf gen/go/
	rm -f envd
	rm -f images/rootfs/rootfs.ext4
