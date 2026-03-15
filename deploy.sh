#!/bin/bash
docker build -t kungfutrader .
docker rm -f kungfutrader-agent
docker run -d -p 8080:8080 --name kungfutrader-agent --restart always kungfutrader
docker logs -f kungfutrader-agent
