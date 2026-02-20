# Stage 1: Build
FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.toml
COPY src/ src/
RUN cargo build --release && strip target/release/syno

# Stage 2: Run
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /src/target/release/syno /usr/local/bin/syno
EXPOSE 3000
ENTRYPOINT ["syno", "mcp"]
CMD ["--host", "0.0.0.0", "--port", "3000"]
