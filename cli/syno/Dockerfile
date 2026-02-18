FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY syno /usr/local/bin/syno
RUN chmod +x /usr/local/bin/syno

EXPOSE 3000

ENTRYPOINT ["syno", "mcp"]
CMD ["--host", "0.0.0.0", "--port", "3000"]
