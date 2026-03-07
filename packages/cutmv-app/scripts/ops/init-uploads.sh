#!/bin/bash

echo "Initializing uploads directory structure..."

# Create uploads directory structure if it doesn't exist
mkdir -p uploads/chunks
mkdir -p uploads/clips

# Create placeholder files to maintain directory structure
touch uploads/chunks/.gitkeep
touch uploads/clips/.gitkeep

echo "Uploads directory initialized successfully!"